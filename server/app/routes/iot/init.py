import json
import os
import hmac
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import secrets
import uuid
from flask import Blueprint, request, jsonify
import jwt

from app.utils.database import database as _db
from app.utils.database.models import DeviceManagement, User, UserDeviceMapping, UserToken, DeviceRefreshToken, TokenBlacklist, TokenUsage
from app.utils.crypto_utils import decrpyt_key, decrypt_data
from app.utils.device_utils import _generate_device_secret, _issue_device_jwt, issue_device_token_pair, check_device_limit, setup_claim_expired
from app.utils.log_utils import log_activity
from app.utils.fcm_utils import send_to_device_master, send_to_user
from app.utils.schedule import match_window, period_key
from app.utils.limiter import limiter

iot_bp = Blueprint("iot", __name__, url_prefix="/iot")



def _is_hex_ciphertext(s: str) -> bool:
    if not s or len(s) % 2 != 0 or len(s) < 64:
        return False
    try:
        bytes.fromhex(s)
        return True
    except ValueError:
        return False


def _is_ble_otp_hex(s: str) -> bool:
    if not s or len(s) != 6:
        return False
    return all(c in "0123456789abcdefABCDEF" for c in s)


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


def _notify_auth_denied(session, user_uuid, device_uuid, reason):
    """인증 거부 사유를 본인에게만 알리고 기록한다(마스터에게는 푸시하지 않고 로그로 남긴다)."""
    mapping  = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid).first()
    nickname = (mapping.device_nickname if mapping and mapping.device_nickname else device_uuid[:8])
    display  = mapping.display_name if mapping else user_uuid
    log_activity("token_denied", user_uuid=user_uuid, device_uuid=device_uuid,
                 detail={"display_name": display, "reason": reason})
    send_to_user(user_uuid, f"{nickname} 기기 알림", f"인증 실패 — {reason}")


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

    log_activity("device_init", device_uuid=device_uuid)
    send_to_device_master(device_uuid, f"{master_nickname} 기기 알림", "기기 전원이 켜졌습니다", data={"type": "refresh_devices"})
    return jsonify({"status": "ok"}), 200


# POST /iot/validate_token
@iot_bp.route("/validate_token", methods=["POST"])
@limiter.limit("20/minute")
def iot_validate_token():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"status": "error", "message": "Missing token"}), 401

    token   = auth_header.removeprefix("Bearer ")
    payload = _decode_device_token(token)

    if not payload or payload.get("type") != "device":
        return jsonify({"status": "error", "message": "Invalid token"}), 401
    device_uuid = payload.get("sub", "")

    data            = request.get_json(silent=True) or {}
    encrypted_token = (data.get("encrypted_token") or "").strip()
    nonce           = (data.get("nonce") or "").strip()

    if not encrypted_token or not nonce:
        return jsonify({"status": "error", "message": "Invalid payload"}), 400

    if not _is_hex_ciphertext(encrypted_token):
        return jsonify({"status": "error", "message": "Invalid encrypted_token format"}), 400

    if not _is_ble_otp_hex(nonce):
        return jsonify({"status": "error", "message": "Invalid nonce format"}), 400

    # user_uuid를 받지 않는다. 이 기기에 매핑된 사용자의 키로 차례로 복호화해
    # 복호화가 되고 nonce까지 일치하는 사용자를 요청자로 본다.
    with _db.Session() as session:
        candidates = (
            session.query(User)
            .join(UserDeviceMapping, UserDeviceMapping.user_uuid == User.user_uuid)
            .filter(UserDeviceMapping.device_uuid == device_uuid)
            .all()
        )

    user = inner = None
    for candidate in candidates:
        try:
            out = decrypt_data(os.environ["MASTER_KEK"], candidate.secret_key, encrypted_token)
            if str(out["data"].get("nonce", "")).lower() != nonce.lower():
                continue
        except Exception:
            continue
        user, inner = candidate, out["data"]
        break

    if user is None:
        return jsonify({"status": "error", "message": "Invalid ciphertext or key"}), 400
    user_uuid = user.user_uuid

    # 토큰 검증
    received_token = inner.get("auth_token", "")
    now = datetime.now(timezone.utc)

    with _db.Session() as session:
        if not received_token:
            _notify_auth_denied(session, user.user_uuid, device_uuid, "발급받은 토큰이 없습니다")
            return jsonify({"status": "error", "message": "no token"}), 400

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
                    return jsonify({"status": "error", "message": "Token invalid"}), 400

                window, start_date = match_window(schedule, local_now)
                if window is None:
                    _notify_auth_denied(session, user.user_uuid, device_uuid, "사용 가능한 시간이 아닙니다")
                    return jsonify({"status": "error", "message": "Token invalid"}), 400

                key   = period_key(window, start_date)
                usage = session.query(TokenUsage).filter_by(token_id=token.id, period_key=key).first()
                if usage is None:
                    usage = TokenUsage(token_id=token.id, period_key=key, uses=0)
                    session.add(usage)
                if usage.uses >= window["max_uses"]:
                    _notify_auth_denied(session, user.user_uuid, device_uuid, "이 시간대에 허용된 횟수를 모두 사용했습니다")
                    return jsonify({"status": "error", "message": "Token invalid"}), 400
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

            return jsonify({"status": "success", "message": "Token validated"}), 200
        else:
            _notify_auth_denied(session, user.user_uuid, device_uuid, "사용할 수 없는 토큰입니다")
            return jsonify({"status": "error", "message": "Token invalid"}), 400

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

    # registered=false면 기기가 스스로 초기화해 셋업 모드로 돌아간다(마스터가 앱에서 삭제한 경우)
    with _db.Session() as session:
        registered = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first() is not None

    log_activity("device_ping", device_uuid=device_uuid)
    return jsonify({"status": "success", "message": "pong", "registered": registered}), 200

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

        # master가 될 사용자는 앱이 보낸 값이 아니라 /client/setup-token 발급 시 서버가 기록한 요청자다.
        user_uuid = device.setup_user_uuid
        if not user_uuid or setup_claim_expired(device.setup_requested_at):
            return jsonify({"status": "error", "message": "Setup not requested"}), 400

        user = session.query(User).filter_by(user_uuid=user_uuid).first()
        if user is None:
            return jsonify({"status": "error", "message": "User not found"}), 400

        if not check_device_limit(session, user_uuid):
            return jsonify({"status": "error", "message": "device limit exceeded"}), 409

        # 업데이트 기기 정보
        new_ble_service_uuid      = str(uuid.uuid4())
        new_ble_read_uuid         = str(uuid.uuid4())
        new_ble_write_uuid        = str(uuid.uuid4())
        new_ble_manufacturer_uuid = str(uuid.uuid4())
        new_setup_token = secrets.token_urlsafe(32)
        saved_secret_key = device.device_secret_key

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
        return jsonify({
            "status": "success",
            "data": new_data
            }), 200
    
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

    with _db.Session() as session:
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if device is None:
            return jsonify({"status": "error", "message": "Device not found"}), 400

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
        return jsonify({
            "status": "success",
            "message": "reset success",
            "data": {
                "access_token": new_access,
                "refresh_token": new_refresh,
            }
            }), 200


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