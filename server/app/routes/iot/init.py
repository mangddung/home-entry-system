import json
import os
import hmac
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import secrets
import uuid
from flask import Blueprint, request, jsonify
from flask_limiter.util import get_remote_address
import jwt

from app.utils.database import database as _db
from app.utils.database.models import DeviceManagement, User, UserDeviceMapping, UserToken, DeviceRefreshToken, TokenBlacklist, TokenUsage
from app.utils.crypto_utils import decrpyt_key, ble_mac
from app.utils.device_utils import _generate_device_secret, _issue_device_jwt, issue_device_token_pair, check_device_limit, setup_claim_expired, hw_fields
from app.utils.log_utils import log_activity
from app.utils.fcm_utils import send_to_device_master, send_to_user
from app.utils.schedule import match_window, period_key
from app.utils.limiter import limiter

iot_bp = Blueprint("iot", __name__, url_prefix="/iot")



def _is_hex(s: str, length: int) -> bool:
    return len(s) == length and all(c in "0123456789abcdefABCDEF" for c in s)


def _is_ble_mac_hex(s: str) -> bool:
    return _is_hex(s, 64)


def _is_ble_otp_hex(s: str) -> bool:
    return _is_hex(s, 16)


def _decode_device_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, os.environ["JWT_SECRET"], algorithms=["HS256"])
    except jwt.PyJWTError:
        return None

    jti = payload.get("jti")
    if not jti:
        # jti 없는 구버전 토큰은 revoke 불가 상태이므로 거부한다.
        # 기기는 /iot/reauth(secret_key)로 자동 재인증되어 새 jti 포함 토큰을 받는다.
        return None

    with _db.Session() as session:
        if session.query(TokenBlacklist).filter_by(jti=jti).first():
            return None
        device = session.query(DeviceManagement).filter_by(device_uuid=payload.get("sub")).first()
        if not device or device.current_jti != jti:
            return None
        # 기기 토큰으로 들어온 모든 요청을 생존 신호로 본다(/iot/ping 5분 주기보다 먼저 온라인 반영)
        device.last_ping_at = datetime.now(timezone.utc)
        session.commit()

    return payload


def _device_rate_key() -> str:
    """유효한 기기 토큰이면 기기별로 센다. 프록시 뒤에서는 모든 기기의 IP가 같아서
    IP로 세면 한 기기의 요청 폭주가 다른 기기의 문 열기까지 막는다."""
    try:
        token = request.headers.get("Authorization", "").removeprefix("Bearer ")
        return jwt.decode(token, os.environ["JWT_SECRET"], algorithms=["HS256"])["sub"]
    except (jwt.PyJWTError, KeyError):
        return get_remote_address()


def _notify_auth_denied(session, user_uuid, device_uuid, reason):
    """인증 거부 사유를 본인에게만 알리고 기록한다(마스터에게는 푸시하지 않고 로그로 남긴다)."""
    mapping  = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid).first()
    nickname = (mapping.device_nickname if mapping and mapping.device_nickname else device_uuid[:8])
    display  = mapping.display_name if mapping else user_uuid
    log_activity("token_denied", user_uuid=user_uuid, device_uuid=device_uuid,
                 detail={"display_name": display, "reason": reason})
    # data: 앱 자동 인증 로그가 서버 거부 결과를 기기·사유별로 남기는 데 쓴다(app/lib/app-handlers.ts)
    send_to_user(user_uuid, f"{nickname} 기기 알림", f"인증 실패 — {reason}",
                 data={"event": "unlock_denied", "device_uuid": device_uuid, "reason": reason})


# POST /iot/init
@iot_bp.route("/init", methods=["POST"])
def iot_init():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"status": "failed", "message": "missing token"}), 401

    token   = auth_header.removeprefix("Bearer ")
    payload = _decode_device_token(token)

    if not payload or payload.get("type") != "device":
        return jsonify({"status": "failed", "message": "invalid token"}), 401

    device_uuid       = payload.get("sub")
    ble_service_uuid  = payload.get("ble_service_uuid")
    ble_read_uuid     = payload.get("ble_read_uuid")
    ble_write_uuid    = payload.get("ble_write_uuid")
    manufacturer_uuid = payload.get("manufacturer_uuid")

    if not all([device_uuid, ble_service_uuid, ble_read_uuid, ble_write_uuid, manufacturer_uuid]):
        return jsonify({"status": "failed", "message": "incomplete payload"}), 400

    with _db.Session() as session:
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        master_mapping = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()
        master_nickname = master_mapping.device_nickname or device_uuid[:8] if master_mapping else device_uuid

        if device is None:
            return jsonify({"status": "failed", "message": "device not found"}), 404

        if (device.ble_service_uuid      != ble_service_uuid  or
            device.ble_read_uuid         != ble_read_uuid     or
            device.ble_write_uuid        != ble_write_uuid    or
            device.ble_manufacturer_uuid != manufacturer_uuid):
            return jsonify({"status": "failed", "message": "uuid mismatch"}), 403

    notify_power_on(device_uuid, master_nickname)
    return jsonify({"status": "ok"}), 200


def notify_power_on(device_uuid: str, master_nickname: str):
    """기기 부팅(서버 init) 알림. Wi-Fi /iot/init과 Zigbee 부팅 ping이 같이 쓴다."""
    log_activity("device_init", device_uuid=device_uuid)
    send_to_device_master(device_uuid, f"{master_nickname} 기기 알림", "기기 전원이 켜졌습니다", data={"type": "refresh_devices"})


# POST /iot/validate_token
@iot_bp.route("/validate_token", methods=["POST"])
@limiter.limit("20/minute", key_func=_device_rate_key)
def iot_validate_token():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"status": "error", "message": "Missing token"}), 401

    token   = auth_header.removeprefix("Bearer ")
    payload = _decode_device_token(token)

    if not payload or payload.get("type") != "device":
        return jsonify({"status": "error", "message": "Invalid token"}), 401
    device_uuid = payload.get("sub", "")

    # encrypted_token 필드에는 mac이 담긴다(펌웨어 요청 형식 유지를 위해 이름은 그대로 둔다)
    data  = request.get_json(silent=True) or {}
    mac   = (data.get("encrypted_token") or "").strip().lower()
    nonce = (data.get("nonce") or "").strip()

    if not mac or not nonce:
        return jsonify({"status": "error", "message": "Invalid payload"}), 400

    if not _is_ble_mac_hex(mac):
        return jsonify({"status": "error", "message": "Invalid mac format"}), 400

    if not _is_ble_otp_hex(nonce):
        return jsonify({"status": "error", "message": "Invalid nonce format"}), 400

    body, status = validate_mac(device_uuid, mac, nonce)
    return jsonify(body), status


def validate_mac(device_uuid: str, mac: str, nonce: str) -> tuple[dict, int]:
    """근접 열기 인증. mac·nonce는 형식 검증을 마친 hex. Wi-Fi(HTTP)·Zigbee(MQTT 워커) 공용.
    반환: (응답 body, HTTP 상태). 200이면 기기가 문을 연다."""
    # user_uuid와 토큰 원문은 받지 않는다. 이 기기에 매핑된 사용자마다 키와 토큰으로
    # mac을 다시 계산해 일치하는 사용자·토큰을 요청자로 본다. nonce는 ESP가 보낸 값이라
    # 과거 mac을 재전송하거나 nonce를 바꿔치기하면 일치하지 않는다.
    with _db.Session() as session:
        candidates = (
            session.query(User)
            .join(UserDeviceMapping, UserDeviceMapping.user_uuid == User.user_uuid)
            .filter(UserDeviceMapping.device_uuid == device_uuid)
            .all()
        )
        # 만료·소진·revoke된 토큰도 후보에 넣는다: 요청자를 특정해야 거부 사유를 본인에게 알릴 수 있다
        device_tokens = (
            session.query(UserToken.user_uuid, UserToken.token_value)
            .filter(UserToken.device_uuid == device_uuid)
            .all()
        )

    user, received_token = None, ""
    for candidate in candidates:
        try:
            key = bytes.fromhex(decrpyt_key(os.environ["MASTER_KEK"], candidate.secret_key))
        except Exception:
            continue
        # "" = 토큰 없이 보낸 경우(mac = HMAC(key, nonce))
        values = [""] + [v for u, v in device_tokens if u == candidate.user_uuid]
        received_token = next((v for v in values if hmac.compare_digest(ble_mac(key, nonce, v), mac)), None)
        if received_token is not None:
            user = candidate
            break

    if user is None:
        return {"status": "error", "message": "Invalid mac or key"}, 400
    user_uuid = user.user_uuid

    # 토큰 검증
    now = datetime.now(timezone.utc)

    with _db.Session() as session:
        if not received_token:
            _notify_auth_denied(session, user.user_uuid, device_uuid, "발급받은 토큰이 없습니다")
            return {"status": "error", "message": "no token"}, 400

        token = session.query(UserToken).filter(
            UserToken.token_value==received_token, 
            UserToken.user_uuid==user.user_uuid, 
            UserToken.device_uuid==device_uuid, 
            UserToken.is_revoked==False,
            (UserToken.max_uses == None) | (UserToken.use_count < UserToken.max_uses),
            (UserToken.not_before == None) | (UserToken.not_before <= now),
            UserToken.expired_at > now
            ).first()
        if token:
            # 반복 사용 규칙(스케줄)이 있으면 요일·시간대·회차 횟수를 추가로 검증한다.
            # 화이트리스트: 열린 창이 없으면 거부.
            if token.schedule_json:
                try:
                    schedule = json.loads(token.schedule_json)
                    local_now = now.astimezone(ZoneInfo(token.schedule_tz))
                except (ValueError, TypeError, ZoneInfoNotFoundError):
                    log_activity("token_schedule_error", user_uuid=user.user_uuid, device_uuid=device_uuid)
                    _notify_auth_denied(session, user.user_uuid, device_uuid, "토큰 설정에 문제가 있습니다")
                    return {"status": "error", "message": "Token invalid"}, 400

                window, start_date = match_window(schedule, local_now)
                if window is None:
                    _notify_auth_denied(session, user.user_uuid, device_uuid, "사용 가능한 시간이 아닙니다")
                    return {"status": "error", "message": "Token invalid"}, 400

                key   = period_key(window, start_date)
                usage = session.query(TokenUsage).filter_by(token_id=token.id, period_key=key).first()
                if usage is None:
                    usage = TokenUsage(token_id=token.id, period_key=key, uses=0)
                    session.add(usage)
                if usage.uses >= window["max_uses"]:
                    _notify_auth_denied(session, user.user_uuid, device_uuid, "이 시간대에 허용된 횟수를 모두 사용했습니다")
                    return {"status": "error", "message": "Token invalid"}, 400
                usage.uses += 1

            token.use_count += 1
            if token.max_uses is not None and token.use_count >= token.max_uses:
                token.is_revoked = True

            user_mapping    = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid).first()
            master_mapping  = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()
            user_display    = user_mapping.display_name if user_mapping else user_uuid
            user_role       = user_mapping.role if user_mapping else "member"
            user_nickname   = user_mapping.device_nickname or device_uuid[:8] if user_mapping else device_uuid[:8]
            master_uuid     = master_mapping.user_uuid if master_mapping else None
            master_nickname = master_mapping.device_nickname or device_uuid[:8] if master_mapping else device_uuid[:8]
            is_master       = master_uuid == user_uuid
            role_label      = "게스트" if user_role == "guest" else "멤버"

            session.commit()
            # 탈퇴·추방으로 매핑이 사라지면 이름을 찾을 곳이 없어지므로 로그에 함께 남긴다
            log_activity("token_validated", user_uuid=user.user_uuid, device_uuid=device_uuid,
                         detail={"display_name": user_display})

            # 사용 횟수가 늘었으므로 인증한 본인 앱의 토큰 캐시를 갱신시킨다
            # event/device_uuid: 앱이 자기 자동 트리거와 짝지어 해제 타이밍 피드백 알림을 띄운다
            send_to_user(user_uuid, f"{user_nickname} 기기 알림", "인증 성공",
                         data={"type": "refresh_devices", "event": "unlock_success", "device_uuid": device_uuid})
            if not is_master and master_uuid:
                send_to_user(master_uuid, f"{master_nickname} 기기 알림", f"{user_display} {role_label}가 인증 성공")

            return {"status": "success", "message": "Token validated"}, 200
        else:
            _notify_auth_denied(session, user.user_uuid, device_uuid, "사용할 수 없는 토큰입니다")
            return {"status": "error", "message": "Token invalid"}, 400

# POST /iot/ping
@iot_bp.route("/ping", methods=["POST"])
def iot_ping():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"status": "failed", "message": "missing token"}), 401

    token   = auth_header.removeprefix("Bearer ")
    payload = _decode_device_token(token)

    if not payload or payload.get("type") != "device":
        return jsonify({"status": "failed", "message": "invalid token"}), 401
    
    # last_ping_at은 _decode_device_token에서 갱신된다(기기 요청 전체 공통)
    device_uuid = payload.get("sub")

    registered = is_registered(device_uuid)
    return jsonify({"status": "success", "message": "pong", "registered": registered}), 200


def is_registered(device_uuid: str) -> bool:
    """false면 기기가 스스로 초기화해 셋업 모드로 돌아간다(마스터가 앱에서 삭제한 경우)."""
    with _db.Session() as session:
        return session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first() is not None

# POST /iot/validate_setup
@iot_bp.route("/validate_setup", methods=["POST"])
def iot_validate_setup():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"status": "error", "message": "Missing token"}), 401

    token   = auth_header.removeprefix("Bearer ")
    payload = _decode_device_token(token)

    if not payload or payload.get("type") != "device":
        return jsonify({"status": "error", "message": "Invalid token"}), 401
    device_uuid = payload.get("sub", "")

    data = request.get_json(silent=True) or {}
    setup_token = (data.get("setup_token") or "").strip()
    secret_key = (data.get("secret_key") or "").strip()

    if not setup_token or not secret_key:
        return jsonify({"status": "error", "message": "Invalid payload"}), 400

    with _db.Session() as session:
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid, setup_token=setup_token).first()
        if device is None:
            return jsonify({"status": "error", "message": "Device not found"}), 400

        # secret key 검증
        db_secret_key = decrpyt_key(os.environ["MASTER_KEK"], device.device_secret_key)
        if not hmac.compare_digest(db_secret_key.encode(), secret_key.encode()):
            return jsonify({"status": "failed", "message": "invalid key"}), 401

        body, status = complete_setup(session, device)
        return jsonify(body), status


def complete_setup(session, device, ble_uuids: tuple[str, str, str, str] | None = None) -> tuple[dict, int]:
    """셋업 토큰 검증을 통과한 기기를 요청자 소유로 등록한다. Wi-Fi(HTTP)·Zigbee(MQTT 워커) 공용.
    ble_uuids: (service, read, write, manufacturer). None이면 새로 뽑는다(Zigbee는 기기와 공유한 seed로 만든 값을 넘긴다).
    반환: (응답 body, HTTP 상태)."""
    device_uuid = device.device_uuid
    # master가 될 사용자는 앱이 보낸 값이 아니라 /client/setup-token 발급 시 서버가 기록한 요청자다.
    user_uuid = device.setup_user_uuid
    if not user_uuid or setup_claim_expired(device.setup_requested_at):
        return {"status": "error", "message": "Setup not requested"}, 400

    user = session.query(User).filter_by(user_uuid=user_uuid).first()
    if user is None:
        return {"status": "error", "message": "User not found"}, 400

    if not check_device_limit(session, user_uuid):
        return {"status": "error", "message": "device limit exceeded"}, 409

    # 업데이트 기기 정보
    (new_ble_service_uuid, new_ble_read_uuid,
     new_ble_write_uuid, new_ble_manufacturer_uuid) = ble_uuids or tuple(str(uuid.uuid4()) for _ in range(4))
    new_setup_token = secrets.token_urlsafe(32)
    saved_secret_key = device.device_secret_key
    saved_hw = hw_fields(device)

    # DB에서 삭제하여 참조하는 다른 테이블 데이터 삭제
    session.delete(device)
    session.flush()

    # 기기 정보 다시 생성 (device_token은 임시값, 아래에서 issue_device_token_pair로 갱신)
    new_device = DeviceManagement(
        device_uuid=device_uuid,
        device_secret_key=saved_secret_key,
        device_token="",
        setup_token=new_setup_token,
        ble_service_uuid=new_ble_service_uuid,
        ble_read_uuid=new_ble_read_uuid,
        ble_write_uuid=new_ble_write_uuid,
        ble_manufacturer_uuid=new_ble_manufacturer_uuid,
        **saved_hw,
    )
    session.add(new_device)
    session.flush()

    new_access, new_refresh = issue_device_token_pair(
        device_uuid, new_ble_service_uuid, new_ble_read_uuid, new_ble_write_uuid,
        new_ble_manufacturer_uuid, session=session,
    )
    new_device.device_token = new_access

    new_mapping = UserDeviceMapping(
        user_uuid=user_uuid,
        device_uuid=device_uuid,
        role="master",
        display_name="master"
    )
    session.add(new_mapping)
    session.commit()

    new_data = {
        "access_token": new_access,
        "refresh_token": new_refresh,
    }
    log_activity("device_setup", user_uuid=user_uuid, device_uuid=device_uuid)
    send_to_user(user_uuid, f"{device_uuid[:8]} 기기 알림", "기기가 등록되었습니다", data={"type": "refresh_devices"})
    return {
        "status": "success",
        "data": new_data
        }, 200
    
# POST /iot/reset
@iot_bp.route("/reset", methods=["POST"])
def iot_reset():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"status": "error", "message": "Missing token"}), 401

    token   = auth_header.removeprefix("Bearer ")
    payload = _decode_device_token(token)

    if not payload or payload.get("type") != "device":
        return jsonify({"status": "error", "message": "Invalid token"}), 401
    device_uuid = payload.get("sub", "")

    body, status = reset_device(device_uuid)
    return jsonify(body), status


def reset_device(device_uuid: str) -> tuple[dict, int]:
    """기기 공장 초기화(BOOT 버튼) 처리: 멤버 추방 후 미등록 상태로 되돌린다. Wi-Fi·Zigbee 공용."""
    with _db.Session() as session:
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if device is None:
            return {"status": "error", "message": "Device not found"}, 400

        master_mapping  = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()
        master_uuid     = master_mapping.user_uuid if master_mapping else None
        master_nickname = master_mapping.device_nickname or device_uuid[:8] if master_mapping else device_uuid[:8]

        members = session.query(UserDeviceMapping).filter(
            UserDeviceMapping.device_uuid == device_uuid,
            UserDeviceMapping.role != "master"
        ).all()
        member_info = [(m.user_uuid, m.device_nickname or device_uuid[:8]) for m in members]

        saved = {
            "device_uuid": device.device_uuid,
            "device_secret_key": device.device_secret_key,
            "device_token": "",
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

        new_access, new_refresh = issue_device_token_pair(
            device_uuid, saved["ble_service_uuid"], saved["ble_read_uuid"], saved["ble_write_uuid"],
            saved["ble_manufacturer_uuid"], session=session,
        )
        new_device.device_token = new_access
        session.commit()

        log_activity("device_reset", device_uuid=device_uuid)
        for member_uuid, nickname in member_info:
            send_to_user(member_uuid, f"{nickname} 기기 알림", "기기 초기화로 그룹에서 추방되었습니다", data={"type": "refresh_devices"})
        if master_uuid:
            send_to_user(master_uuid, f"{master_nickname} 기기 알림", "기기가 리셋되었습니다", data={"type": "refresh_devices"})
        return {
            "status": "success",
            "message": "reset success",
            "data": {
                "access_token": new_access,
                "refresh_token": new_refresh,
            }
            }, 200


# POST /iot/refresh  Authorization: Bearer <old_access_token>  { "refresh_token": "..." }
@iot_bp.route("/refresh", methods=["POST"])
def iot_refresh():
    body          = request.get_json(silent=True) or {}
    refresh_token = (body.get("refresh_token") or "").strip()
    if not refresh_token:
        return jsonify({"status": "error", "message": "refresh_token required"}), 400

    # 기존 access token이 헤더에 있으면 블랙리스트 등록 (만료됐어도 처리)
    old_jti = None
    old_exp = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        old_token = auth_header.removeprefix("Bearer ")
        try:
            old_payload = jwt.decode(
                old_token, os.environ["JWT_SECRET"], algorithms=["HS256"],
                options={"verify_exp": False},
            )
            old_jti = old_payload.get("jti")
            old_exp = datetime.fromtimestamp(old_payload["exp"], tz=timezone.utc)
        except jwt.PyJWTError:
            pass

    now = datetime.now(timezone.utc)

    with _db.Session() as session:
        row = session.query(DeviceRefreshToken).filter_by(token_value=refresh_token).first()

        if not row:
            return jsonify({"status": "error", "message": "invalid refresh token"}), 401
        if row.expired_at.replace(tzinfo=timezone.utc) < now:
            session.delete(row)
            session.commit()
            return jsonify({"status": "error", "message": "refresh token expired"}), 401

        device_uuid = row.device_uuid
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if device is None:
            return jsonify({"status": "error", "message": "device not found"}), 404

        device.last_ping_at = now

        if old_jti and old_exp:
            session.merge(TokenBlacklist(jti=old_jti, expired_at=old_exp))

        session.delete(row)
        session.flush()

        new_access, new_refresh = issue_device_token_pair(
            device_uuid, device.ble_service_uuid, device.ble_read_uuid, device.ble_write_uuid,
            device.ble_manufacturer_uuid, session=session,
        )
        device.device_token = new_access
        session.commit()

    return jsonify({
        "status": "success",
        "data": {
            "access_token": new_access,
            "refresh_token": new_refresh,
        }
        }), 200


# POST /iot/reauth  { "device_uuid": "...", "secret_key": "..." }
@iot_bp.route("/reauth", methods=["POST"])
def iot_reauth():
    data        = request.get_json(silent=True) or {}
    device_uuid = (data.get("device_uuid") or "").strip()
    secret_key  = (data.get("secret_key") or "").strip()

    if not device_uuid or not secret_key:
        return jsonify({"status": "error", "message": "Invalid payload"}), 400

    with _db.Session() as session:
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if device is None:
            return jsonify({"status": "error", "message": "Device not found"}), 400

        db_secret_key = decrpyt_key(os.environ["MASTER_KEK"], device.device_secret_key)
        if not hmac.compare_digest(db_secret_key.encode(), secret_key.encode()):
            return jsonify({"status": "failed", "message": "invalid key"}), 401

        device.last_ping_at = datetime.now(timezone.utc)
        session.query(DeviceRefreshToken).filter_by(device_uuid=device_uuid).delete()

        new_access, new_refresh = issue_device_token_pair(
            device_uuid, device.ble_service_uuid, device.ble_read_uuid, device.ble_write_uuid,
            device.ble_manufacturer_uuid, session=session,
        )
        device.device_token = new_access
        session.commit()

    log_activity("device_reauth", device_uuid=device_uuid)
    return jsonify({
        "status": "success",
        "data": {
            "access_token": new_access,
            "refresh_token": new_refresh,
        }
        }), 200