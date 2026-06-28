import secrets
from datetime import datetime, timezone, timedelta
import os

from flask import Blueprint, request, jsonify

from app.utils.database import database as _db
from app.utils.database import UserDeviceMapping, DeviceManagement, UserToken
from app.utils.database.models import DeviceLocation, InviteCode, Settings, User
from app.utils.fcm_utils import send_to_user
from app.utils.log_utils import log_activity
from sqlalchemy.orm import joinedload
from app.routes.client.auth import verify_access_token

member_bp = Blueprint("members", __name__, url_prefix="/client")

# POST /client/invite-code
@member_bp.route("/invite-code", methods=["POST"])
def create_invite_code():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    device_uuid = (data.get("device_uuid") or "").strip()
    display_name = (data.get("display_name") or "").strip()
    role = (data.get("role") or "").strip()

    if not device_uuid or not display_name or not role:
        return jsonify({"status": "error", "message": "invalid payload"}), 400    
    
    if not role in ["member", "guest"]:
        return jsonify({"status": "error", "message": "invalid role"}), 400    

    with _db.Session() as session:
        mapping = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid, role="master").first()
        if not mapping:
            return jsonify({"status": "error", "message": "not found mapping"}), 401
        
        device_nickname = mapping.device_nickname or device_uuid[:8]
        role_name = "멤버" if role=="member" else "게스트"

        # 중복 문제 있음
        new_invite_code = secrets.token_urlsafe(64)

        now = datetime.now(timezone.utc)
        new_invite_codes = InviteCode (
            invite_code = new_invite_code,
            device_uuid = device_uuid,
            creator_uuid = user_uuid,
            display_name = display_name,
            role = role,
            expired_at = now + timedelta(days=1)
        )
        session.add(new_invite_codes)
        session.commit()

        log_activity("member_invite_code_created", user_uuid=user_uuid, device_uuid=device_uuid, detail={"role": role, "display_name": display_name})
        send_to_user(user_uuid, f"{device_nickname} 기기 알림", f"{display_name} {role_name} 초대 코드가 생성되었습니다.")    

        response = {"device_uuid": device_uuid, "invite_code": new_invite_code, "display_name": display_name}
    
    return jsonify({"status": "success", "data": response}), 200


# GET /client/invite-code
@member_bp.route("/invite-code", methods=["GET"])
def get_invite_code():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]
    device_uuid = (request.args.get("device_uuid") or "").strip()

    if not device_uuid:
        return jsonify({"status": "error", "message": "invalid payload"}), 400    
    
    now = datetime.now(timezone.utc)
    with _db.Session() as session:
        user_mapping = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid, role="master").first()
        if not user_mapping:
            return jsonify({"status": "error", "message": "forbidden"}), 403

        invite_codes = session.query(InviteCode).filter_by(
            device_uuid=device_uuid, creator_uuid=user_uuid, is_used=False).filter(InviteCode.expired_at>now).all()

        response = [{
            "display_name": i.display_name,
            "invite_code": i.invite_code,
            "role": i.role,
            "expired_at": i.expired_at.isoformat() + "Z" if i.expired_at else None,
            "created_at": i.created_at.isoformat() + "Z" if i.created_at else None,
        } for i in invite_codes]

        return jsonify({"status": "success", "data": response}), 200
    

# DELETE /client/invite-code
@member_bp.route("/invite-code", methods=["DELETE"])
def revoke_invite_code():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    invite_code = (request.args.get("invite_code") or "").strip()

    if not invite_code:
        return jsonify({"status": "error", "message": "invalid payload"}), 400    

    with _db.Session() as session:    
        invite_row = session.query(InviteCode).filter_by(creator_uuid=user_uuid, invite_code=invite_code).first()
        if not invite_row:
            return jsonify({"status": "error", "message": "invalid code"}), 404
        
        device_uuid = invite_row.device_uuid
        user_mapping = session.query(UserDeviceMapping).filter_by(user_uuid=user_uuid, device_uuid=device_uuid, role="master").first()
        if not user_mapping:
            return jsonify({"status": "error", "message": "forbidden"}), 403
        
        device_nickname = user_mapping.device_nickname or device_uuid[:8]
        role = invite_row.role
        role_name = "멤버" if role=="member" else "게스트"
        display_name = invite_row.display_name
        
        session.delete(invite_row)
        session.commit()

        log_activity("member_invite_code_deleted", user_uuid=user_uuid, device_uuid=device_uuid, detail={"role": role_name, "display_name": display_name})
        send_to_user(user_uuid, f"{device_nickname} 기기 알림", f"{display_name} {role_name} 초대 코드가 삭제되었습니다.")    

        return jsonify({"status": "success", "message": "revoke success"}), 200


# GET /client/member
@member_bp.route("/member", methods=["GET"])
def get_member_list():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]
    device_uuid = (request.args.get("device_uuid") or "").strip()

    if not device_uuid:
        return jsonify({"status": "error", "message": "invalid payload"}), 400    

    with _db.Session() as session:
        mapping = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid).all()
        if not mapping:
            return jsonify({"status": "error", "message": "forbidden"}), 403

        if not any(m.user_uuid == user_uuid for m in mapping):
            return jsonify({"status": "error", "message": "forbidden"}), 403
        
        response = [{
            "user_uuid": i.user_uuid,
            "role": i.role,
            "display_name": i.display_name,
            "created_at": i.created_at.isoformat() + "Z" if i.created_at else None,
        } for i in mapping]

        return jsonify({"status": "success", "data": response}), 200
    

# DELETE /client/member
@member_bp.route("/member", methods=["DELETE"])
def delete_member():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]
    member_uuid = (request.args.get("member_uuid") or "").strip()
    device_uuid = (request.args.get("device_uuid") or "").strip()

    if not member_uuid or not device_uuid:
        return jsonify({"status": "error", "message": "invalid payload"}), 400    

    with _db.Session() as session:
        user = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid, role="master").first()
        if not user:
            return jsonify({"status": "error", "message": "forbidden"}), 403

        target_user = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=member_uuid).first()
        if not target_user:
            return jsonify({"status": "error", "message": "invalid member"}), 400
        
        tuser_uuid = target_user.user_uuid
        tuser_display_name = target_user.display_name
        tuser_role_name = "멤버" if target_user.role=="member" else "게스트"
        tuser_device_name = target_user.device_nickname or device_uuid[:8]

        master_device_name = user.device_nickname or device_uuid[:8]
        
        session.query(UserToken).filter_by(user_uuid=member_uuid, device_uuid=device_uuid).delete()
        session.delete(target_user)
        session.commit()

        log_activity("member_kicked", user_uuid=user_uuid, device_uuid=device_uuid, detail={"role": tuser_role_name, "display_name": tuser_display_name})
        send_to_user(tuser_uuid, f"{tuser_device_name} 기기 알림", "그룹에서 추방되었습니다.")  
        send_to_user(user_uuid, f"{master_device_name} 기기 알림", f"{tuser_display_name}님을 그룹에서 추방하였습니다.")  

        return jsonify({"status": "success", "message": "successed delete member"}), 200
    

# POST /client/guest-token
@member_bp.route("/guest-token", methods=["POST"])
def create_guest_token():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    device_uuid = (data.get("device_uuid") or "").strip()
    guest_uuid  = (data.get("guest_uuid") or "").strip()
    max_uses       = data.get("max_uses")
    not_before     = data.get("not_before")
    expire_minutes = data.get("expire_minutes")

    if not device_uuid or not guest_uuid or not max_uses or not expire_minutes:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    try:
        now           = datetime.now(timezone.utc)
        expired_at_dt = now + timedelta(minutes=int(expire_minutes))
        max_uses      = int(max_uses)
    except (ValueError, TypeError):
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    try:
        not_before_dt = datetime.fromisoformat(not_before.replace("Z", "+00:00")) if not_before else None
    except (ValueError, TypeError):
        return jsonify({"status": "error", "message": "invalid not_before"}), 400

    if not_before_dt and not_before_dt <= now:
        return jsonify({"status": "error", "message": "not_before must be in the future"}), 400

    with _db.Session() as session:
        master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid, role="master").first()
        if not master:
            return jsonify({"status": "error", "message": "forbidden"}), 403

        guest = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=guest_uuid, role="guest").first()
        if not guest:
            return jsonify({"status": "error", "message": "guest not found"}), 404
        
        guest_device_name = guest.device_nickname or device_uuid[:8]
        master_device_name = master.device_nickname or device_uuid[:8]

        token = UserToken(
            token_value = secrets.token_urlsafe(32),
            user_uuid   = guest_uuid,
            device_uuid = device_uuid,
            max_uses    = max_uses,
            not_before  = not_before_dt,
            expired_at  = expired_at_dt,
        )
        session.add(token)
        session.commit()

        log_activity("member_guest_token_created", user_uuid=user_uuid, device_uuid=device_uuid, detail={"role": "guest", "display_name": guest.display_name})
        send_to_user(guest.user_uuid, f"{guest_device_name} 기기 알림", "토큰이 발급되었습니다.")  
        send_to_user(user_uuid, f"{master_device_name} 기기 알림", f"{guest.display_name}의 토큰이 발급되었습니다.")

        return jsonify({"status": "success", "message": "created guest token"}), 200


# GET /client/guest-token
@member_bp.route("/guest-token", methods=["GET"])
def get_guest_token():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid   = payload["sub"]
    device_uuid = (request.args.get("device_uuid") or "").strip()
    guest_uuid  = (request.args.get("guest_uuid") or "").strip()

    if not device_uuid or not guest_uuid:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    with _db.Session() as session:
        master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid, role="master").first()
        if not master:
            return jsonify({"status": "error", "message": "forbidden"}), 403

        guest = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=guest_uuid, role="guest").first()
        if not guest:
            return jsonify({"status": "error", "message": "guest not found"}), 404

        tokens = session.query(UserToken).filter_by(
            user_uuid=guest_uuid, device_uuid=device_uuid, is_revoked=False
        ).all()

        data = [{
            "id":         t.id,
            "max_uses":   t.max_uses,
            "use_count":  t.use_count,
            "not_before": t.not_before.isoformat() + "Z" if t.not_before else None,
            "expired_at": t.expired_at.isoformat() + "Z" if t.expired_at else None,
            "created_at": t.created_at.isoformat() + "Z" if t.created_at else None,
        } for t in tokens]

        return jsonify({"status": "success", "data": data}), 200


# DELETE /client/guest-token
@member_bp.route("/guest-token", methods=["DELETE"])
def delete_guest_token():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]
    device_uuid = (request.args.get("device_uuid") or "").strip()
    token_id    = (request.args.get("id") or "").strip()

    if not device_uuid or not token_id:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    with _db.Session() as session:
        master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid, role="master").first()
        if not master:
            return jsonify({"status": "error", "message": "forbidden"}), 403

        token = session.query(UserToken).filter_by(id=token_id, device_uuid=device_uuid).first()
        if not token:
            return jsonify({"status": "error", "message": "token not found"}), 404

        guest = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=token.user_uuid, role="guest").first()
        if not guest:
            return jsonify({"status": "error", "message": "not a guest token"}), 403

        guest_display_name = guest.display_name
        guest_user_uuid = guest.user_uuid
        guest_device_name = guest.device_nickname or device_uuid[:8]
        master_device_name = master.device_nickname or device_uuid[:8]

        session.delete(token)
        session.commit()

        log_activity("member_guest_token_deleted", user_uuid=user_uuid, device_uuid=device_uuid, detail={"role": "guest", "display_name": guest_display_name})
        send_to_user(guest_user_uuid, f"{guest_device_name} 기기 알림", "토큰이 삭제되었습니다.")
        send_to_user(user_uuid, f"{master_device_name} 기기 알림", f"{guest_display_name}의 토큰이 삭제되었습니다.")  

        return jsonify({"status": "success"}), 200
