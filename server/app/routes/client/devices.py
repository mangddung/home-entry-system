import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timezone, timedelta
import os

from flask import Blueprint, request, jsonify

from app.utils.crypto_utils import decrpyt_key
from app.utils.fcm_utils import send_to_device_master, send_to_device_role, send_to_user
from app.utils.log_utils import log_activity
from firebase_admin import messaging

from app.utils.database import database as _db
from app.utils.database import UserDeviceMapping, DeviceManagement, UserToken
from app.utils.database.models import DeviceLocation, Settings, User
from sqlalchemy import or_
from sqlalchemy.orm import joinedload
from app.utils.device_utils import SETUP_CLAIM_TTL, battery_percent, hw_fields
from app.utils.mqtt_utils import notify_zigbee_check_registration, open_zigbee_join
from app.routes.client.auth import verify_access_token
from app.routes.iot.init import reset_device
from app.utils.limiter import limiter
from flask_limiter.util import get_remote_address

client_bp = Blueprint("client", __name__, url_prefix="/client")


def _user_rate_key() -> str:
    """유효한 사용자 토큰이면 사용자별로 센다. 프록시 뒤에서는 IP가 모두 같아 IP로 세면 남의 셋업까지 막는다."""
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    return payload["sub"] if not err else get_remote_address()

SETUP_SERVICE_UUID = os.environ["SETUP_SERVICE_UUID"]
SETUP_WRITE_UUID = os.environ["SETUP_WRITE_UUID"]
SETUP_READ_UUID = os.environ["SETUP_READ_UUID"]

def _get_or_create_token(session, user_uuid: str, device_uuid: str, role: str) -> dict:
    now = datetime.now(timezone.utc)

    token = (
        session.query(UserToken)
        .filter(
            UserToken.user_uuid == user_uuid,
            UserToken.device_uuid == device_uuid,
            UserToken.is_revoked == False,
            UserToken.expired_at > now,
        )
        .first()
    )

    # 마스터·멤버의 5회 한도는 폰이 오프라인일 때를 대비한 것이다. 이 조회가 됐다는 건 서버와 통신이 되는 것이므로
    # 한 번이라도 쓴 토큰은 새 토큰으로 바꿔 오프라인에서 쓸 수 있는 횟수를 늘 가득 채워 둔다.
    # 인증 성공 푸시(refresh_devices)로 앱이 곧바로 이 목록을 다시 받으므로 온라인이면 쓰자마자 채워진다.
    # 게스트 토큰은 마스터가 정한 횟수라 바꾸지 않는다.
    if token is not None and role != "guest" and token.use_count > 0:
        token.is_revoked = True
        token = None

    if token is None:
        if role == "guest":
            return None

        # 만료된 토큰 체크
        session.query(UserToken).filter(
            UserToken.user_uuid == user_uuid,
            UserToken.device_uuid == device_uuid,
            UserToken.is_revoked == False,
        ).update({"is_revoked": True})

        # 추후 IoT 설정, 역할에 따른 max_uses / not_before / expired_at 조정
        token = UserToken(
            token_value=secrets.token_urlsafe(32),
            user_uuid=user_uuid,
            device_uuid=device_uuid,
            max_uses=5,
            use_count=0,
            not_before=None,
            expired_at=now + timedelta(days=7),
        )
        session.add(token)
        log_activity("member_token_generated", user_uuid=user_uuid, device_uuid=device_uuid, session=session)

    # 방금 만든 토큰은 시각이 tz-aware라 isoformat에 +00:00이 붙는다. 그대로 Z를 붙이면 "+00:00Z"가 되어
    # 앱이 날짜로 못 읽고 토큰을 무효로 본다. DB에서 읽은 값(naive UTC)과 같은 형식으로 맞춘다.
    iso = lambda dt: dt.replace(tzinfo=None).isoformat() + "Z" if dt else None
    return {
        "token_value": token.token_value,
        "max_uses":    token.max_uses,
        "use_count":   token.use_count,
        "not_before":  iso(token.not_before),
        "expired_at":  iso(token.expired_at),
        # 게스트 앱이 시간대 밖에서 BLE 스캔을 쉬도록 규칙을 함께 내려준다(판정은 서버가 최종).
        "schedule":    json.loads(token.schedule_json) if token.schedule_json else None,
        "schedule_tz": token.schedule_tz,
    }


# GET /client/devices
@client_bp.route("/devices", methods=["GET"])
def get_user_devices():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    with _db.Session() as session:
        mappings = (
            session.query(UserDeviceMapping)
            .filter_by(user_uuid=user_uuid)
            .options(joinedload(UserDeviceMapping.device).joinedload(DeviceManagement.location))
            .all()
        )

        result = [
            {
                "device_uuid": m.device_uuid,
                "device_nickname": m.device_nickname,
                "role": m.role,
                "ble_uuids": {
                    "ble_service_uuid":      m.device.ble_service_uuid,
                    "ble_write_uuid":        m.device.ble_write_uuid,
                    "ble_read_uuid":         m.device.ble_read_uuid,
                    "ble_manufacturer_uuid": m.device.ble_manufacturer_uuid,
                },
                "auth_token": _get_or_create_token(session, m.user_uuid, m.device_uuid, m.role),
                "location": {
                    "latitude":    m.device.location.latitude,
                    "longitude":   m.device.location.longitude,
                } if m.device.location else None,
                "last_ping_at": m.device.last_ping_at.isoformat() + "Z" if m.device.last_ping_at else None,
                "rssi_threshold": m.device.rssi_threshold,
                # Wi-Fi 모델은 상시 전원이라 보여주지 않는다
                "battery_percent": battery_percent(m.device.battery_mv) if m.device.transport == "zigbee" else None,
                "transport": m.device.transport,
            }
            for m in mappings
        ]
        session.commit()

    return jsonify({"status": "success", "data": result}), 200

# GET /client/setup-uuid
@client_bp.route("/setup-uuid", methods=["GET"])
def get_setup_uuid():
    _, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401
    return jsonify({
        "status": "success",
        "data": {
            "device_uuid": "device-setup",
            "device_nickname": None,
            "role": None,
            "ble_uuids": {
                "ble_service_uuid":      SETUP_SERVICE_UUID,
                "ble_write_uuid":        SETUP_WRITE_UUID,
                "ble_read_uuid":         SETUP_READ_UUID,
                "ble_manufacturer_uuid": None,
            },
            "auth_token": None,
            "location": None,
            "last_ping_at": None,
        }
    }), 200

# POST /client/setup-token
@client_bp.route("/setup-token", methods=["POST"])
@limiter.limit("10/minute", key_func=_user_rate_key)  # 미등록 기기 점유를 반복해 셋업을 막는 것을 늦춘다
def get_setup_token():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    device_uuid = (data.get("device_uuid") or "").strip()

    # 기기가 초기화됐지만 그때 서버(Wi-Fi)·게이트웨이(Zigbee)에 알리지 못해 이전 master가 남은 경우.
    # 기기가 셋업 때 앱에 준 리셋 증명 HMAC(기기 비밀키, "reset|<현재 BLE 서비스 UUID>")이 맞으면 여기서 리셋을 반영한다.
    # 서비스 UUID는 셋업 완료 때마다 새로 정해져(리셋으로는 안 바뀜) 지난 셋업에서 본 증명은 다시 쓸 수 없다 (esp32/main/ble_server.c와 짝).
    reset_proof = data.get("reset_proof")
    if isinstance(reset_proof, str) and re.fullmatch(r"[0-9a-f]{64}", reset_proof):
        with _db.Session() as session:
            device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
            master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()
            missed_reset = bool(device and device.ble_service_uuid and master and master.user_uuid != user_uuid)
            if missed_reset:
                key = bytes.fromhex(decrpyt_key(os.environ["MASTER_KEK"], device.device_secret_key))
                expected = hmac.new(key, f"reset|{device.ble_service_uuid}".encode(), hashlib.sha256).hexdigest()
                missed_reset = hmac.compare_digest(expected, reset_proof)
        if missed_reset:
            reset_device(device_uuid)

    with _db.Session() as session:
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if not device:
            return jsonify({"status": "error", "message": "invalid device"}), 400

        # 등록된 기기는 마스터 본인만 다시 설정할 수 있다. UUID를 아는 사람(추방된 멤버 등)이
        # 점유를 갱신해 재설정을 막거나 setup_token을 받아가지 못하게 한다.
        master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()
        if master and master.user_uuid != user_uuid:
            return jsonify({"status": "error", "message": "forbidden"}), 403
        registered = master is not None

        # 요청자를 master 후보로 점유한다. 다른 사용자가 점유 중(미만료)이면 거부.
        # 조건부 UPDATE 한 번으로 확인과 기록을 원자적으로 처리한다.
        now = datetime.utcnow()
        claimable = or_(
            DeviceManagement.setup_user_uuid.is_(None),
            DeviceManagement.setup_user_uuid == user_uuid,
            DeviceManagement.setup_requested_at < now - SETUP_CLAIM_TTL,
        )
        # 점유자가 바뀌면 setup_token을 새로 발급한다. 이전 점유자가 기기에 넘긴 토큰이 무효가 되어,
        # 만료된 점유를 가로챈 사람이 이전 셋업의 완료로 master가 되는 경로를 막는다.
        # 같은 사용자의 재요청(재시도)은 토큰을 유지한다. 같은 트랜잭션이라 아래 점유 UPDATE와 사이에 끼어들 수 없다.
        session.query(DeviceManagement).filter(
            DeviceManagement.device_uuid == device_uuid,
            claimable,
            or_(DeviceManagement.setup_user_uuid.is_(None), DeviceManagement.setup_user_uuid != user_uuid),
        ).update({"setup_token": secrets.token_urlsafe(32)}, synchronize_session=False)
        claimed = session.query(DeviceManagement).filter(
            DeviceManagement.device_uuid == device_uuid,
            claimable,
        ).update({"setup_user_uuid": user_uuid, "setup_requested_at": now}, synchronize_session=False)
        if not claimed:
            session.rollback()
            return jsonify({"status": "error", "message": "setup in progress by another user"}), 409
        session.commit()
        transport = device.transport
        setup_token = session.query(DeviceManagement.setup_token).filter_by(device_uuid=device_uuid).scalar()

    # Zigbee 모델은 기기가 이제 게이트웨이 네트워크에 가입해야 한다(앱이 곧 셋업 토큰을 BLE로 넘긴다).
    # 이미 등록된 기기로는 열지 않는다(아무 device_uuid로 가입 창을 여는 것을 막는다).
    if transport == "zigbee" and not registered:
        open_zigbee_join()

    log_activity("device_setup_token_served", user_uuid=user_uuid, device_uuid=device_uuid)
    # transport: 앱이 셋업 분기(Wi-Fi 입력 / Zigbee)를 고르고 광고의 모델 코드와 교차 확인한다
    return jsonify({"status": "success", "data": {"setup_token": setup_token, "transport": transport}}), 200

# GET /client/unfigured-devices
@client_bp.route("/unfigured-devices", methods=["GET"])
def get_unfigured_devices():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    with _db.Session() as session:
        # 위치·설정 등록은 master만 가능하므로 master 기기만 안내한다
        user_devices = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, role="master").all()
        if not user_devices:
            return jsonify({"status": "success", "data": []}), 200
        device_uuids = [d.device_uuid for d in user_devices]

        configured_location = {d.device_uuid for d in session.query(DeviceLocation).filter(DeviceLocation.device_uuid.in_(device_uuids)).all()}
        configured_setting  = {d.device_uuid for d in session.query(Settings).filter(Settings.device_uuid.in_(device_uuids)).all()}

        unfigured_location = set(device_uuids) - configured_location
        unfigured_setting  = set(device_uuids) - configured_setting

        result = [
            {"device_uuid": device_uuid, "type": "location"}
            for device_uuid in unfigured_location
        ] + [
            {"device_uuid": device_uuid, "type": "setting"}
            for device_uuid in unfigured_setting
        ]
        return jsonify({"status": "success", "data": result}), 200

# POST /client/device-location
@client_bp.route("/device-location", methods=["POST"])
def get_device_location():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    device_uuid     = (data.get("device_uuid") or "").strip()
    device_nickname = (data.get("device_nickname") or "").strip()

    try:
        latitude    = float(data.get("latitude", 0))
        longitude   = float(data.get("longitude", 0))
    except (ValueError, TypeError):
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    if not device_uuid or not latitude or not longitude:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    with _db.Session() as session:
        user_device = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid, role="master").first()
        if not user_device:
            return jsonify({"status": "error", "message": "forbidden"}), 403
        if device_nickname:
            user_device.device_nickname = device_nickname

        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if not device:
            return jsonify({"status": "error", "message": "invalid payload"}), 400

        device_location = session.query(DeviceLocation).filter_by(device_uuid=device_uuid).first()
        if not device_location:
            new_location = DeviceLocation(
                device_uuid = device_uuid,
                latitude = latitude,
                longitude = longitude,
            )
            session.add(new_location)
            session.commit()

            log_activity("device_location_added", user_uuid=user_uuid, device_uuid=device_uuid)
            send_to_user(user_uuid, f"{device_uuid[:8]} 기기 알림", "기기 위치가 등록되었습니다", data={"type": "refresh_devices"})
        else:
            device_location.latitude = latitude
            device_location.longitude = longitude
            session.commit()
            
            log_activity("device_location_updated", user_uuid=user_uuid, device_uuid=device_uuid)
            # 멤버·게스트 앱이 지오펜스를 새 좌표로 다시 등록하도록 refresh_devices를 싣는다
            send_to_device_role(device_uuid, ["master", "member", "guest"], f"{device_uuid[:8]} 기기 알림", "기기 위치가 갱신되었습니다", data={"type": "refresh_devices"})


        return jsonify({"status": "success", "message": "success"}), 200

# POST /client/device-rssi-threshold
# 근접 해제 기기 임계값(dBm). master만 변경. null이면 해제(첫 발견 즉시 연결로 복귀).
RSSI_THRESHOLD_MIN, RSSI_THRESHOLD_MAX = -100, -20

@client_bp.route("/device-rssi-threshold", methods=["POST"])
def update_rssi_threshold():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    device_uuid = (data.get("device_uuid") or "").strip()
    threshold = data.get("rssi_threshold")
    # bool은 int의 하위 타입이라 따로 거른다
    if not device_uuid or (threshold is not None and (
        isinstance(threshold, bool) or not isinstance(threshold, int)
        or not RSSI_THRESHOLD_MIN <= threshold <= RSSI_THRESHOLD_MAX
    )):
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    with _db.Session() as session:
        master = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid, role="master").first()
        if not master:
            return jsonify({"status": "error", "message": "forbidden"}), 403
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if not device:
            return jsonify({"status": "error", "message": "invalid payload"}), 400

        device.rssi_threshold = threshold
        nickname = master.device_nickname or device_uuid[:8]
        session.commit()

    log_activity("device_rssi_threshold_updated", user_uuid=user_uuid, device_uuid=device_uuid,
                 detail={"rssi_threshold": threshold})
    # 자동 해제를 쓰는 마스터·멤버 앱이 새 기준을 받아가도록 refresh_devices를 싣는다
    send_to_device_role(device_uuid, ["master", "member"], f"{nickname} 기기 알림",
                        "근접 해제 기준이 변경되었습니다", data={"type": "refresh_devices"})
    return jsonify({"status": "success", "message": "success"}), 200

# POST /client/device-servo-command
# 서보 범위 변경 명령에 서명한다. master만. 앱이 BLE로 기기에 전달하면 기기가 서명을 확인하고 저장한다.
# 저장값의 기준은 기기 NVS라 서버는 보관하지 않는다 (esp32/main/ble_server.c와 짝).
SERVO_DEG_MIN, SERVO_DEG_MAX = 0, 180
SERVO_MIN_SWING_DEG = 10

def _valid_servo_deg(value) -> bool:
    # bool은 int의 하위 타입이라 따로 거른다
    return isinstance(value, int) and not isinstance(value, bool) and SERVO_DEG_MIN <= value <= SERVO_DEG_MAX

def _valid_ble_nonce(nonce) -> bool:
    return isinstance(nonce, str) and re.fullmatch(r"[0-9a-f]{16}", nonce) is not None

def _sign_as_master(user_uuid: str, device_uuid: str, message: str):
    """master만 기기 비밀키로 message에 서명받는다. 반환: (mac, 기기 별명, None) 또는 (None, None, 오류 응답)."""
    with _db.Session() as session:
        master = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid, role="master").first()
        if not master:
            return None, None, (jsonify({"status": "error", "message": "forbidden"}), 403)
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if not device:
            return None, None, (jsonify({"status": "error", "message": "invalid payload"}), 400)
        encrypted_secret = device.device_secret_key
        nickname = master.device_nickname or device_uuid[:8]

    key = bytes.fromhex(decrpyt_key(os.environ["MASTER_KEK"], encrypted_secret))
    return hmac.new(key, message.encode(), hashlib.sha256).hexdigest(), nickname, None

@client_bp.route("/device-servo-command", methods=["POST"])
def sign_servo_command():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    device_uuid = (data.get("device_uuid") or "").strip()
    nonce = data.get("nonce")
    low_deg = data.get("low_deg")
    high_deg = data.get("high_deg")
    if (not device_uuid or not _valid_ble_nonce(nonce)
        or not _valid_servo_deg(low_deg) or not _valid_servo_deg(high_deg)
        or abs(low_deg - high_deg) < SERVO_MIN_SWING_DEG):
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    mac, _, error = _sign_as_master(user_uuid, device_uuid, f"servo|{nonce}|{low_deg}|{high_deg}")
    if error:
        return error

    log_activity("device_servo_range_requested", user_uuid=user_uuid, device_uuid=device_uuid,
                 detail={"low_deg": low_deg, "high_deg": high_deg})
    return jsonify({"status": "success", "data": {"command": f"SRV:{low_deg}:{high_deg}:{mac}"}}), 200

# POST /client/device-ble-grant
# master 권한을 BLE 연결 하나에 넘겨준다. 앱이 서명을 기기에 전달하면 기기가 확인한다 (esp32/main/ble_server.c와 짝).
#   live: 서보 실시간 조절 / bond: 이 휴대폰으로 재본딩(마스터에게 알림)
# 본딩만으로는 권한을 주지 않는다. 계정을 되찾은 뒤에도 공격자 폰의 본딩이 문을 움직이지 못하게 연결마다 서버가 확인한다.
BLE_GRANTS = {
    "live": {"prefix": "SRVS", "domain": "ble-live", "action": "device_ble_live_started"},
    "bond": {"prefix": "SRVB", "domain": "ble-bond", "action": "device_ble_rebond_requested"},
}

@client_bp.route("/device-ble-grant", methods=["POST"])
def sign_ble_grant():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    device_uuid = (data.get("device_uuid") or "").strip()
    nonce = data.get("nonce")
    purpose = data.get("purpose")
    if not device_uuid or not _valid_ble_nonce(nonce) or not isinstance(purpose, str) or purpose not in BLE_GRANTS:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    grant = BLE_GRANTS[purpose]
    mac, nickname, error = _sign_as_master(user_uuid, device_uuid, f"{grant['domain']}|{nonce}")
    if error:
        return error

    log_activity(grant["action"], user_uuid=user_uuid, device_uuid=device_uuid)
    if purpose == "bond":
        # 수동 인증처럼 탈취된 계정의 행동이 조용히 지나가지 않게 마스터에게 알린다
        send_to_device_role(device_uuid, "master", f"{nickname} 기기 알림",
                            "휴대폰 재연결이 요청되었습니다. 본인이 아니면 계정을 확인하세요")
    return jsonify({"status": "success", "data": {"command": f"{grant['prefix']}:{mac}"}}), 200

# DELETE /client/device
@client_bp.route("/device", methods=["DELETE"])
def delete_device():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    device_uuid = (request.args.get("device_uuid") or "").strip()

    if not device_uuid:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    with _db.Session() as session:
        user_device = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid, role="master").first()
        if not user_device:
            return jsonify({"status": "error", "message": "forbidden"}), 403
        device_nickname = user_device.device_nickname or device_uuid[:8]

        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if device is None:
            return jsonify({"status": "error", "message": "device not found"}), 400

        # 삭제 시 매핑이 cascade로 사라지므로 알림 대상은 미리 모은다
        notify_uuids = [m.user_uuid for m in session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid).all()]
        # 새 행은 게이트웨이 묶음을 풀므로 신호 보낼 곳도 미리 챙긴다
        zigbee_target = (device.gateway_id, device.ieee_addr) if device.transport == "zigbee" else None

        saved = {
            "device_uuid": device.device_uuid,
            "device_secret_key": device.device_secret_key,
            "device_token": device.device_token,
            "setup_token": device.setup_token,
            "ble_service_uuid": device.ble_service_uuid,
            "ble_read_uuid": device.ble_read_uuid,
            "ble_write_uuid": device.ble_write_uuid,
            "ble_manufacturer_uuid": device.ble_manufacturer_uuid,
            **hw_fields(device),
            "gateway_id": None,  # 미등록이 되면 게이트웨이 묶음을 푼다(다음 셋업에서 다시 묶인다)
        }

        session.delete(device)
        session.flush()

        new_device = DeviceManagement(**saved)
        session.add(new_device)
        session.flush()
        session.commit()

        log_activity("device_deleted", user_uuid=user_uuid, device_uuid=device_uuid)
        if zigbee_target and all(zigbee_target):
            notify_zigbee_check_registration(*zigbee_target)
        # 멤버·게스트 앱이 삭제된 기기의 지오펜스·캐시를 내리도록 refresh_devices를 싣는다
        for uid in notify_uuids:
            send_to_user(uid, f"{device_nickname} 기기 알림", "기기가 삭제되었습니다", data={"type": "refresh_devices"})

        return jsonify({"status": "success", "message": "success"}), 200

# DELETE /client/device-membership
@client_bp.route("/device-membership", methods=["DELETE"])
def delete_device_membership():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    device_uuid = (request.args.get("device_uuid") or "").strip()

    if not device_uuid:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    with _db.Session() as session:
        user_device = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid).first()

        if not user_device:
            return jsonify({"status": "error", "message": "not found"}), 404

        if user_device.role == "master":
            return jsonify({"status": "error", "message": "master cannot leave, delete the device instead"}), 403

        user_display_name = user_device.display_name or user_uuid[:8]
        user_role = user_device.role
        user_nickname = user_device.device_nickname or device_uuid[:8] if user_device.device_nickname else device_uuid[:8]

        master_mapping  = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()
        master_uuid     = master_mapping.user_uuid if master_mapping else None
        master_nickname = master_mapping.device_nickname or device_uuid[:8] if master_mapping else device_uuid[:8]

        # 매핑만 지우면 유효 토큰이 고아로 남는다(강퇴 경로와 동일하게 정리).
        # 일괄 delete()는 ORM cascade를 건너뛰어 token_usages가 고아로 남고, 재사용된 토큰 id가 그 횟수를 물려받는다.
        for t in session.query(UserToken).filter_by(user_uuid=user_uuid, device_uuid=device_uuid):
            session.delete(t)
        session.delete(user_device)
        session.commit()

        log_activity("member_leaved", user_uuid=user_uuid, device_uuid=device_uuid,
                     detail={"display_name": user_display_name, "role": user_role})
        send_to_user(user_uuid, f"{user_nickname} 기기 알림", f"그룹을 떠났습니다", data={"type": "refresh_devices"})
        if master_uuid:
            send_to_user(master_uuid, f"{master_nickname} 기기 알림", f"{user_display_name}가 그룹을 떠났습니다", data={"type": "refresh_devices"})
        return jsonify({"status": "success", "message": "success"}), 200


# POST /client/device-name
@client_bp.route("/device-name", methods=["POST"])
def update_device_name():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    device_uuid = (data.get("device_uuid") or "").strip()
    device_nickname = (data.get("device_nickname") or "").strip()

    with _db.Session() as session:
        device = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid).first()
        if not device:
            return jsonify({"status": "error", "message": "not found"}), 404

        device.device_nickname = device_nickname
        session.commit()
        return jsonify({"status": "success", "message": "success"}), 200
