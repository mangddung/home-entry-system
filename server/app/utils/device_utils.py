import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from functools import wraps

import jwt
from cryptography.fernet import Fernet

from app.utils.database import database as _db
from app.utils.database.models import DeviceManagement, DeviceRefreshToken, UserDeviceMapping

ACCESS_TOKEN_TTL  = timedelta(hours=12)
REFRESH_TOKEN_TTL = timedelta(days=180)

MAX_DEVICES_PER_USER = 20

# /client/setup-token 요청자를 기기 설정이 끝날 때까지 점유하는 시간
SETUP_CLAIM_TTL = timedelta(minutes=15)

def setup_claim_expired(requested_at) -> bool:
    """requested_at은 DB에서 읽은 naive UTC. 없으면 만료로 본다."""
    if requested_at is None:
        return True
    return datetime.utcnow() - requested_at > SETUP_CLAIM_TTL

def hw_fields(device) -> dict:
    """기기 행을 지우고 다시 만드는 경로(설정 완료·리셋·앱 삭제)에서 그대로 옮겨야 하는 하드웨어 정보."""
    return {"transport": device.transport, "ieee_addr": device.ieee_addr, "gateway_id": device.gateway_id}

# ponytail: 일반 LiPo 무부하 전압의 대략값. 실제 셀의 방전 곡선을 재면 교체한다.
_BATTERY_CURVE = ((3300, 0), (3600, 10), (3700, 25), (3750, 40), (3800, 55), (3900, 70), (4000, 85), (4150, 100))

def battery_percent(mv: int | None) -> int | None:
    """셀 전압(mV)을 잔량(%)으로 바꾼다. 곡선이 비선형이라 구간별로 보간한다."""
    if mv is None:
        return None
    if mv <= _BATTERY_CURVE[0][0]:
        return 0
    for (low_mv, low_pct), (high_mv, high_pct) in zip(_BATTERY_CURVE, _BATTERY_CURVE[1:]):
        if mv <= high_mv:
            return round(low_pct + (mv - low_mv) * (high_pct - low_pct) / (high_mv - low_mv))
    return 100

def check_device_limit(session, user_uuid: str) -> bool:
    """유저가 등록/참여한 기기 총 개수(역할 무관)가 제한 미만인지 확인"""
    count = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid).count()
    return count < MAX_DEVICES_PER_USER

def _generate_device_secret() -> tuple[str, str]:
    """AES-16바이트 키 생성 후 MASTER_KEK으로 Fernet 암호화.
    Returns (raw_hex, encrypted_for_db)"""
    master_kek = os.environ["MASTER_KEK"].encode()
    raw_key = os.urandom(16)
    raw_hex = raw_key.hex()
    encrypted = Fernet(master_kek).encrypt(raw_hex.encode()).decode()
    return raw_hex, encrypted


def _issue_device_jwt(device_uuid: str, ble_service_uuid: str, ble_read_uuid: str,
                      ble_write_uuid: str, ble_manufacturer_uuid: str, jti: str | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "sub":              device_uuid,
        "type":             "device",
        "jti":              jti or str(uuid.uuid4()),
        "ble_service_uuid": ble_service_uuid,
        "ble_read_uuid":    ble_read_uuid,
        "ble_write_uuid":   ble_write_uuid,
        "manufacturer_uuid": ble_manufacturer_uuid,
        "iat":              now,
        "exp":              now + ACCESS_TOKEN_TTL,
    }
    return jwt.encode(payload, os.environ["JWT_SECRET"], algorithm="HS256")


def issue_device_token_pair(device_uuid: str, ble_service_uuid: str, ble_read_uuid: str,
                             ble_write_uuid: str, manufacturer_uuid: str, session=None) -> tuple[str, str]:
    jti          = str(uuid.uuid4())
    access_token = _issue_device_jwt(device_uuid, ble_service_uuid, ble_read_uuid,
                                      ble_write_uuid, manufacturer_uuid, jti=jti)

    now           = datetime.now(timezone.utc)
    refresh_token = secrets.token_urlsafe(48)
    refresh_row   = DeviceRefreshToken(
        token_value = refresh_token,
        device_uuid = device_uuid,
        expired_at  = now + REFRESH_TOKEN_TTL,
    )

    if session:
        session.query(DeviceRefreshToken).filter_by(device_uuid=device_uuid).delete()
        session.add(refresh_row)
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if device:
            device.current_jti = jti
    else:
        with _db.Session() as s:
            s.query(DeviceRefreshToken).filter_by(device_uuid=device_uuid).delete()
            s.add(refresh_row)
            device = s.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
            if device:
                device.current_jti = jti
            s.commit()

    return access_token, refresh_token