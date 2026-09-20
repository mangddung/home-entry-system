import json
import secrets
from datetime import datetime, timezone, timedelta
import os

from flask import Blueprint, request, jsonify

from app.utils.fcm_utils import send_to_device_master, send_to_device_role, send_to_user
from app.utils.log_utils import log_activity
from firebase_admin import messaging

from app.utils.database import database as _db
from app.utils.database import UserDeviceMapping, DeviceManagement, UserToken
from app.utils.database.models import DeviceLocation, Settings, User
from sqlalchemy import or_
from sqlalchemy.orm import joinedload
from app.utils.device_utils import SETUP_CLAIM_TTL
from app.routes.client.auth import verify_access_token

client_bp = Blueprint("client", __name__, url_prefix="/client")

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

    return {
        "token_value": token.token_value,
        "max_uses":    token.max_uses,
        "use_count":   token.use_count,
        "not_before":  token.not_before.isoformat() + "Z" if token.not_before else None,
        "expired_at":  token.expired_at.isoformat() + "Z" if token.expired_at else None,
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
                    "latitude":    m.device.location.latitude    if m.device.location else None,
                    "longitude":   m.device.location.longitude   if m.device.location else None,
                },
                "last_ping_at": m.device.last_ping_at.isoformat() + "Z" if m.device.last_ping_at else None,
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
            "location": {
                "latitude":    None,
                "longitude":   None,
            },
            "last_ping_at": None,
        }
    }), 200

# POST /client/setup-token
@client_bp.route("/setup-token", methods=["POST"])
def get_setup_token():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    device_uuid = (data.get("device_uuid") or "").strip()

    with _db.Session() as session:
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if not device:
            return jsonify({"status": "error", "message": "invalid device"}), 400

        # 요청자를 master 후보로 점유한다. 다른 사용자가 점유 중(미만료)이면 거부.
        # 조건부 UPDATE 한 번으로 확인과 기록을 원자적으로 처리한다.
        now = datetime.utcnow()
        claimed = session.query(DeviceManagement).filter(
            DeviceManagement.device_uuid == device_uuid,
            or_(
                DeviceManagement.setup_user_uuid.is_(None),
                DeviceManagement.setup_user_uuid == user_uuid,
                DeviceManagement.setup_requested_at < now - SETUP_CLAIM_TTL,
            ),
        ).update({"setup_user_uuid": user_uuid, "setup_requested_at": now}, synchronize_session=False)
        if not claimed:
            return jsonify({"status": "error", "message": "setup in progress by another user"}), 409
        session.commit()

        log_activity("device_setup_token_served", user_uuid=user_uuid, device_uuid=device_uuid)
        return jsonify({"status": "success", "data": {"setup_token": device.setup_token}}), 200

# GET /client/unfigured-devices
@client_bp.route("/unfigured-devices", methods=["GET"])
def get_unfigured_devices():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    with _db.Session() as session:
        user_devices = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid).all()
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

        saved = {
            "device_uuid": device.device_uuid,
            "device_secret_key": device.device_secret_key,
            "device_token": device.device_token,
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
        session.commit()

        log_activity("device_deleted", user_uuid=user_uuid, device_uuid=device_uuid)
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
