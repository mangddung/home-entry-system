import uuid
import os
import secrets
import requests
from datetime import datetime, timedelta, timezone

from cryptography.fernet import Fernet
from flask import Blueprint, request, jsonify
from app.utils.database.models import InviteCode, UserDeviceMapping, UserToken
from app.utils.device_utils import check_device_limit
import jwt

from app.utils.database import database as _db
from app.utils.database import UserRefreshToken, TokenBlacklist, KakaoOAuthToken, User
from app.utils.log_utils import log_activity
from app.utils.fcm_utils import send_to_user, send_to_device_master

KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token"

auth_bp = Blueprint("auth", __name__, url_prefix="/auth")

ACCESS_TOKEN_TTL  = timedelta(hours=24)
REFRESH_TOKEN_TTL = timedelta(days=30)


def verify_access_token(auth_header: str) -> tuple[dict | None, str | None]:
    if not auth_header.startswith("Bearer "):
        return None, "missing token"

    token = auth_header.removeprefix("Bearer ")
    try:
        payload = jwt.decode(token, os.environ["JWT_SECRET"], algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        return None, "token expired"
    except jwt.PyJWTError:
        return None, "invalid token"

    if payload.get("type") == "device":
        return None, "invalid token"

    jti = payload.get("jti")
    if jti:
        with _db.Session() as session:
            if session.query(TokenBlacklist).filter_by(jti=jti).first():
                return None, "token revoked"
            user = session.query(User).filter_by(user_uuid=payload["sub"]).first()
            if not user or user.current_jti != jti:
                return None, "token revoked"

    return payload, None


# GET /auth/verify
@auth_bp.route("/verify", methods=["GET"])
def verify_token():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"valid": False, "error": err}), 401
    return jsonify({"valid": True, "user_uuid": payload["sub"]}), 200


# POST /auth/refresh  Authorization: Bearer <old_access_token>  { "refresh_token": "..." }
@auth_bp.route("/refresh", methods=["POST"])
def token_refresh():
    body          = request.get_json(silent=True) or {}
    refresh_token = body.get("refresh_token", "").strip()
    if not refresh_token:
        return jsonify({"error": "refresh_token required"}), 400

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
        row = session.query(UserRefreshToken).filter_by(token_value=refresh_token).first()

        if not row:
            return jsonify({"error": "invalid refresh token"}), 401
        if row.expired_at.replace(tzinfo=timezone.utc) < now:
            session.delete(row)
            session.commit()
            return jsonify({"error": "refresh token expired"}), 401

        user_uuid = row.user_uuid

        if old_jti and old_exp:
            session.merge(TokenBlacklist(jti=old_jti, expired_at=old_exp))

        _refresh_kakao_token_if_needed(session, user_uuid)

        session.delete(row)
        session.flush()

        new_access, new_refresh = issue_token_pair(user_uuid, session=session)
        session.commit()

    return jsonify({"access_token": new_access, "refresh_token": new_refresh})


# POST /auth/logout  Authorization: Bearer <access_token>
@auth_bp.route("/logout", methods=["POST"])
def logout():
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"error": "missing token"}), 401

    token = auth_header.removeprefix("Bearer ")
    try:
        payload = jwt.decode(token, os.environ["JWT_SECRET"], algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        payload = jwt.decode(token, os.environ["JWT_SECRET"], algorithms=["HS256"],
                             options={"verify_exp": False})
    except jwt.PyJWTError:
        return jsonify({"error": "invalid token"}), 401

    jti       = payload.get("jti")
    user_uuid = payload.get("sub")
    exp       = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)

    with _db.Session() as session:
        if jti:
            session.merge(TokenBlacklist(jti=jti, expired_at=exp))
        session.query(UserRefreshToken).filter_by(user_uuid=user_uuid).delete()
        user = session.query(User).filter_by(user_uuid=user_uuid).first()
        if user:
            user.current_jti = None
        session.commit()

    log_activity("logout", user_uuid=user_uuid)
    return jsonify({"status": "ok"})


# GET /auth/secret-key  — 요청마다 새 키 생성, 평문 반환 후 DB 암호화 저장
@auth_bp.route("/secret-key", methods=["GET"])
def get_secret_key():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"error": err}), 401

    user_uuid = payload["sub"]

    with _db.Session() as session:
        user = session.query(User).filter_by(user_uuid=user_uuid).first()
        if not user:
            return jsonify({"error": "user not found"}), 404

        raw_hex = os.urandom(16).hex()
        user.secret_key = Fernet(os.environ["MASTER_KEK"].encode()).encrypt(raw_hex.encode()).decode()
        session.commit()

    return jsonify({"secret_key": raw_hex}), 200

# GET /auth/invite-code/preview
@auth_bp.route("/invite-code/preview", methods=["GET"])
def preview_invite_code():
    """초대 코드를 소모하지 않고 가입 대상 기기 정보만 조회한다."""
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid   = payload["sub"]
    invite_code = (request.args.get("invite_code") or "").strip()

    if not invite_code:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    now = datetime.now(timezone.utc)
    with _db.Session() as session:
        invite_row = session.query(InviteCode).filter_by(
            invite_code=invite_code, is_used=False
        ).filter(InviteCode.expired_at > now).first()
        if not invite_row:
            return jsonify({"status": "error", "reason": "invalid", "message": "invalid invite code"}), 404

        device_uuid = invite_row.device_uuid

        existing = session.query(UserDeviceMapping).filter_by(
            device_uuid=device_uuid, user_uuid=user_uuid
        ).first()
        if existing:
            return jsonify({"status": "error", "reason": "already_joined", "message": "already joined"}), 409

        if not check_device_limit(session, user_uuid):
            return jsonify({"status": "error", "reason": "device_limit", "message": "device limit exceeded"}), 409

        master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()

        data = {
            "device_uuid_prefix": device_uuid[:8] if device_uuid else None,
            "device_nickname":    (master.device_nickname if master else None) or (device_uuid[:8] if device_uuid else None),
            "role":               invite_row.role,
            "display_name":       invite_row.display_name,
            "inviter_name":       master.display_name if master else None,
            "expired_at":         invite_row.expired_at.isoformat() + "Z" if invite_row.expired_at else None,
        }

        if invite_row.role == "guest":
            data.update({
                "token_max_uses":       invite_row.token_max_uses,
                "token_expire_minutes": invite_row.token_expire_minutes,
                "token_not_before":     invite_row.token_not_before.isoformat() + "Z" if invite_row.token_not_before else None,
            })

        return jsonify({"status": "success", "data": data}), 200


# POST /auth/join
@auth_bp.route("/join", methods=["POST"])
def join_device():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    invite_code = (data.get("invite_code") or "").strip()

    now = datetime.now(timezone.utc)
    with _db.Session() as session:
        invite_row = session.query(InviteCode).filter_by(invite_code=invite_code, is_used=False).filter(InviteCode.expired_at > now).first()
        if not invite_row:
            return jsonify({"status": "error", "message": "invalid invite code"}), 401
        
        existing = session.query(UserDeviceMapping).filter_by(
            device_uuid=invite_row.device_uuid, user_uuid=user_uuid
        ).first()
        if existing:
            return jsonify({"status": "error", "message": "already joined"}), 409

        if not check_device_limit(session, user_uuid):
            return jsonify({"status": "error", "message": "device limit exceeded"}), 409

        invite_row.is_used = True

        device_uuid  = invite_row.device_uuid
        display_name = invite_row.display_name
        role         = invite_row.role
        role_label   = "게스트" if role == "guest" else "멤버"

        master_mapping  = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()
        master_uuid     = master_mapping.user_uuid if master_mapping else None
        master_nickname = master_mapping.device_nickname or device_uuid[:8] if master_mapping else device_uuid[:8]

        new_mapping = UserDeviceMapping(
            device_uuid  = device_uuid,
            user_uuid    = user_uuid,
            role         = role,
            display_name = display_name,
        )
        session.add(new_mapping)

        # 초대 코드에 사전 토큰 정보가 있으면 가입과 동시에 게스트 토큰을 발급한다.
        if role == "guest" and invite_row.token_expire_minutes:
            session.add(UserToken(
                token_value = secrets.token_urlsafe(32),
                user_uuid   = user_uuid,
                device_uuid = device_uuid,
                max_uses    = invite_row.token_max_uses or 1,
                not_before  = invite_row.token_not_before,
                expired_at  = now + timedelta(minutes=invite_row.token_expire_minutes),
            ))

        session.commit()

        log_activity("member_joined", user_uuid=user_uuid, device_uuid=device_uuid)
        send_to_user(user_uuid, f"{device_uuid[:8]} 기기 알림", f"{role_label} 권한으로 등록되었습니다", data={"type": "refresh_devices"})
        if master_uuid:
            send_to_user(master_uuid, f"{master_nickname} 기기 알림", f"{display_name} 유저 초대 코드 수락", data={"type": "refresh_devices"})

        return jsonify({"status": "success", "message": "success", "data": {"device_uuid": device_uuid}}), 200

def issue_token_pair(user_uuid: str, session=None) -> tuple[str, str]:
    now          = datetime.now(timezone.utc)
    jti          = str(uuid.uuid4())
    access_token = jwt.encode(
        {"sub": user_uuid, "jti": jti,
         "iat": now, "exp": now + ACCESS_TOKEN_TTL},
        os.environ["JWT_SECRET"], algorithm="HS256",
    )

    refresh_token = secrets.token_urlsafe(48)
    refresh_row   = UserRefreshToken(
        token_value = refresh_token,
        user_uuid   = user_uuid,
        expired_at  = now + REFRESH_TOKEN_TTL,
    )

    if session:
        session.query(UserRefreshToken).filter_by(user_uuid=user_uuid).delete()
        session.add(refresh_row)
        user = session.query(User).filter_by(user_uuid=user_uuid).first()
        if user:
            user.current_jti = jti
    else:
        with _db.Session() as s:
            s.query(UserRefreshToken).filter_by(user_uuid=user_uuid).delete()
            s.add(refresh_row)
            user = s.query(User).filter_by(user_uuid=user_uuid).first()
            if user:
                user.current_jti = jti
            s.commit()

    return access_token, refresh_token


def _refresh_kakao_token_if_needed(session, user_uuid: str) -> None:
    oauth_row = session.query(KakaoOAuthToken).filter_by(user_uuid=user_uuid).first()
    if not oauth_row or not oauth_row.refresh_token:
        return

    now        = datetime.now(timezone.utc)
    expires_at = oauth_row.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)

    if expires_at > now + timedelta(minutes=10):
        return

    resp = requests.post(
        KAKAO_TOKEN_URL,
        data={
            "grant_type":    "refresh_token",
            "client_id":     os.environ["KAKAO_CLIENT_ID"],
            "client_secret": os.environ.get("KAKAO_CLIENT_SECRET", ""),
            "refresh_token": oauth_row.refresh_token,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=10,
    )
    if not resp.ok:
        return

    data = resp.json()
    oauth_row.access_token = data["access_token"]
    oauth_row.expires_at   = now + timedelta(seconds=data.get("expires_in", 21600))
    if "refresh_token" in data:
        oauth_row.refresh_token = data["refresh_token"]
    oauth_row.updated_at = now
