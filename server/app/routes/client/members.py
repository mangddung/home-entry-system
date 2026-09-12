import json
import secrets
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import os

from flask import Blueprint, request, jsonify

from app.utils.database import database as _db
from app.utils.database import UserDeviceMapping, DeviceManagement, UserToken
from app.utils.database.models import DeviceLocation, InviteCode, Settings, TokenUsage, User
from app.utils.fcm_utils import send_to_user
from app.utils.log_utils import log_activity
from sqlalchemy import func
from sqlalchemy.orm import joinedload
from app.routes.client.auth import verify_access_token
from app.utils.schedule import validate_schedule, windows_for_date, period_key

member_bp = Blueprint("members", __name__, url_prefix="/client")


def parse_token_options(max_uses, not_before, expire_minutes, now, allow_unlimited=False):
    """게스트 토큰 옵션 검증. (max_uses, not_before_dt, expire_minutes) 반환.
    실패 시 (None, None, None, error_message).
    allow_unlimited이면 max_uses 생략 가능(전체 횟수 제한 없음 = None)."""
    if not expire_minutes:
        return None, None, None, "invalid payload"
    if not max_uses and not allow_unlimited:
        return None, None, None, "invalid payload"

    try:
        max_uses       = int(max_uses) if max_uses else None
        expire_minutes = int(expire_minutes)
    except (ValueError, TypeError):
        return None, None, None, "invalid payload"

    if expire_minutes <= 0 or (max_uses is not None and max_uses <= 0):
        return None, None, None, "invalid payload"

    try:
        not_before_dt = datetime.fromisoformat(not_before.replace("Z", "+00:00")) if not_before else None
    except (ValueError, TypeError, AttributeError):
        return None, None, None, "invalid not_before"

    if not_before_dt and not_before_dt <= now:
        return None, None, None, "not_before must be in the future"

    return max_uses, not_before_dt, expire_minutes, None


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

    # 게스트 초대에 한해 사전 토큰 정보를 함께 지정할 수 있다.
    now = datetime.now(timezone.utc)
    token_max_uses = token_not_before_dt = token_expire_minutes = None
    if role == "guest" and (data.get("token_max_uses") or data.get("token_expire_minutes")):
        token_max_uses, token_not_before_dt, token_expire_minutes, opt_err = parse_token_options(
            data.get("token_max_uses"), data.get("token_not_before"),
            data.get("token_expire_minutes"), now)
        if opt_err:
            return jsonify({"status": "error", "message": opt_err}), 400

    with _db.Session() as session:
        mapping = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid, role="master").first()
        if not mapping:
            return jsonify({"status": "error", "message": "not found mapping"}), 401
        
        # 같은 기기 안에서 표시 이름이 겹치면 멤버 목록에서 구분이 안 되므로 막는다.
        # (대소문자 무시. ponytail: 마스터 1명만 발급하므로 동시성 경합은 무시, 잦아지면 유니크 인덱스 추가)
        name_key = display_name.lower()
        dup_member = session.query(UserDeviceMapping).filter(
            UserDeviceMapping.device_uuid == device_uuid,
            func.lower(UserDeviceMapping.display_name) == name_key,
        ).first()
        if dup_member:
            return jsonify({"status": "error", "message": "이미 같은 이름의 멤버가 있습니다."}), 409

        dup_invite = session.query(InviteCode).filter(
            InviteCode.device_uuid == device_uuid,
            InviteCode.is_used == False,
            InviteCode.expired_at > now,
            func.lower(InviteCode.display_name) == name_key,
        ).first()
        if dup_invite:
            return jsonify({"status": "error", "message": "같은 이름으로 발급된 초대 코드가 있습니다."}), 409

        device_nickname = mapping.device_nickname or device_uuid[:8]
        role_name = "멤버" if role=="member" else "게스트"

        new_invite_code = secrets.token_urlsafe(64)

        new_invite_codes = InviteCode (
            invite_code = new_invite_code,
            device_uuid = device_uuid,
            creator_uuid = user_uuid,
            display_name = display_name,
            role = role,
            expired_at = now + timedelta(days=1),
            token_max_uses       = token_max_uses,
            token_expire_minutes = token_expire_minutes,
            token_not_before     = token_not_before_dt,
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
            "token_max_uses":       i.token_max_uses,
            "token_expire_minutes": i.token_expire_minutes,
            "token_not_before":     i.token_not_before.isoformat() + "Z" if i.token_not_before else None,
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

        # 마스터에게만 게스트별 유효 토큰 보유 여부를 내려준다(목록에서 "토큰 없음" 표시용).
        is_master = any(m.user_uuid == user_uuid and m.role == "master" for m in mapping)
        with_token = set()
        if is_master:
            now = datetime.now(timezone.utc)
            with_token = {
                r[0] for r in session.query(UserToken.user_uuid).filter(
                    UserToken.device_uuid == device_uuid,
                    UserToken.is_revoked == False,
                    UserToken.expired_at > now,
                ).all()
            }

        response = [{
            "user_uuid": i.user_uuid,
            "role": i.role,
            "display_name": i.display_name,
            "created_at": i.created_at.isoformat() + "Z" if i.created_at else None,
            **({"has_token": i.user_uuid in with_token} if is_master and i.role == "guest" else {}),
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
        
        # 일괄 delete()는 ORM cascade를 건너뛰어 token_usages가 고아로 남는다(탈퇴 경로와 동일).
        for t in session.query(UserToken).filter_by(user_uuid=member_uuid, device_uuid=device_uuid):
            session.delete(t)
        session.delete(target_user)
        session.commit()

        log_activity("member_kicked", user_uuid=user_uuid, device_uuid=device_uuid, detail={"role": tuser_role_name, "display_name": tuser_display_name})
        send_to_user(tuser_uuid, f"{tuser_device_name} 기기 알림", "그룹에서 추방되었습니다.", data={"type": "refresh_devices"})  
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
    schedule       = data.get("schedule")
    schedule_tz    = (data.get("tz") or "").strip()

    if not device_uuid or not guest_uuid:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    schedule_norm = None
    if schedule is not None:
        schedule_norm, sched_err = validate_schedule(schedule)
        if sched_err:
            return jsonify({"status": "error", "message": sched_err}), 400
        try:
            ZoneInfo(schedule_tz)
        except (ZoneInfoNotFoundError, ValueError, TypeError):
            return jsonify({"status": "error", "message": "invalid timezone"}), 400

    now = datetime.now(timezone.utc)
    # 스케줄이 있으면 창별 횟수가 한도 역할을 하므로 전체 횟수는 생략할 수 있다.
    max_uses, not_before_dt, expire_minutes, opt_err = parse_token_options(
        max_uses, not_before, expire_minutes, now, allow_unlimited=schedule_norm is not None)
    if opt_err:
        return jsonify({"status": "error", "message": opt_err}), 400

    expired_at_dt = now + timedelta(minutes=expire_minutes)

    with _db.Session() as session:
        master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid, role="master").first()
        if not master:
            return jsonify({"status": "error", "message": "forbidden"}), 403

        guest = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=guest_uuid, role="guest").first()
        if not guest:
            return jsonify({"status": "error", "message": "guest not found"}), 404

        # 만료된 토큰이 목록에 남아 재발급을 막는 것처럼 보이므로 먼저 정리한다.
        session.query(UserToken).filter(
            UserToken.user_uuid == guest_uuid,
            UserToken.device_uuid == device_uuid,
            UserToken.is_revoked == False,
            UserToken.expired_at <= now,
        ).update({"is_revoked": True})

        # 게스트당 유효 토큰은 1개만 유지한다(앱은 토큰을 하나만 캐시한다).
        active = session.query(UserToken).filter(
            UserToken.user_uuid == guest_uuid,
            UserToken.device_uuid == device_uuid,
            UserToken.is_revoked == False,
            UserToken.expired_at > now,
        ).first()
        if active:
            session.commit()
            return jsonify({"status": "error", "message": "token already issued"}), 409

        guest_device_name = guest.device_nickname or device_uuid[:8]
        master_device_name = master.device_nickname or device_uuid[:8]

        token = UserToken(
            token_value = secrets.token_urlsafe(32),
            user_uuid   = guest_uuid,
            device_uuid = device_uuid,
            max_uses    = max_uses,
            not_before  = not_before_dt,
            expired_at  = expired_at_dt,
            schedule_json = json.dumps(schedule_norm) if schedule_norm else None,
            schedule_tz   = schedule_tz if schedule_norm else None,
        )
        session.add(token)
        session.commit()

        log_activity("member_guest_token_created", user_uuid=user_uuid, device_uuid=device_uuid, detail={"role": "guest", "display_name": guest.display_name})
        send_to_user(guest.user_uuid, f"{guest_device_name} 기기 알림", "토큰이 발급되었습니다.", data={"type": "refresh_devices"})  
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
        if guest_uuid == user_uuid:
            # 본인 토큰 조회 – 해당 기기의 멤버이기만 하면 허용
            target = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid).first()
            if not target:
                return jsonify({"status": "error", "message": "forbidden"}), 403
        else:
            master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid, role="master").first()
            if not master:
                return jsonify({"status": "error", "message": "forbidden"}), 403

            target = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=guest_uuid, role="guest").first()
            if not target:
                return jsonify({"status": "error", "message": "guest not found"}), 404

        tokens = session.query(UserToken).filter_by(
            user_uuid=guest_uuid, device_uuid=device_uuid, is_revoked=False
        ).all()

        now = datetime.now(timezone.utc)

        # 스케줄 토큰은 전체 누적보다 "오늘 몇 번 남았나"가 의미 있으므로 오늘 회차 합계를 내려준다.
        # 오늘 = 발급 시간대 기준 날짜. 오늘 시작하는 창만 센다(어제 밤 시작해 자정을 넘긴 창은 제외).
        def today_usage(t):
            if not t.schedule_json or not t.schedule_tz:
                return None
            try:
                today = now.astimezone(ZoneInfo(t.schedule_tz)).date()
            except (ZoneInfoNotFoundError, ValueError):
                return None
            windows = windows_for_date(json.loads(t.schedule_json), today)
            keys = [period_key(w, today) for w in windows]
            used = {u.period_key: u.uses for u in session.query(TokenUsage).filter(
                TokenUsage.token_id == t.id, TokenUsage.period_key.in_(keys))} if keys else {}
            return {
                "uses":     sum(used.get(k, 0) for k in keys),
                "max_uses": sum(w["max_uses"] for w in windows),
            }

        data = [{
            "id":         t.id,
            "is_active":  bool(t.expired_at and t.expired_at.replace(tzinfo=timezone.utc) > now),
            "max_uses":   t.max_uses,
            "use_count":  t.use_count,
            "not_before": t.not_before.isoformat() + "Z" if t.not_before else None,
            "expired_at": t.expired_at.isoformat() + "Z" if t.expired_at else None,
            "created_at": t.created_at.isoformat() + "Z" if t.created_at else None,
            "schedule":   json.loads(t.schedule_json) if t.schedule_json else None,
            "schedule_tz": t.schedule_tz,
            "today":      today_usage(t),
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
        send_to_user(guest_user_uuid, f"{guest_device_name} 기기 알림", "토큰이 삭제되었습니다.", data={"type": "refresh_devices"})
        send_to_user(user_uuid, f"{master_device_name} 기기 알림", f"{guest_display_name}의 토큰이 삭제되었습니다.")  

        return jsonify({"status": "success"}), 200
