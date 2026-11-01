import hashlib
import hmac
import re
import secrets
import uuid
import os
import requests
from datetime import datetime, timedelta, timezone

from flask import Blueprint, request, jsonify, redirect

from app.utils.database import database as _db
from app.utils.database import User, KakaoOAuthToken, OAuthLoginCode
from app.routes.client.auth import issue_token_pair
from app.utils.log_utils import log_activity
from app.utils.limiter import limiter

kakao_bp = Blueprint("kakao", __name__, url_prefix="/auth")
limiter.limit("10/minute")(kakao_bp)

KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token"
KAKAO_USER_URL  = "https://kapi.kakao.com/v2/user/me"

LOGIN_CODE_TTL = timedelta(seconds=60)
STATE_RE = re.compile(r"[0-9a-f]{64}")


# GET /auth/kakao/config
@kakao_bp.route("/kakao/config", methods=["GET"])
def kakao_config():
    return jsonify({
        "client_id":    os.environ["KAKAO_CLIENT_ID"],
        "redirect_uri": os.environ["KAKAO_REDIRECT_URI"],
    })


# GET /auth/kakao/callback?code=...&state=<sha256(verifier)>
@kakao_bp.route("/kakao/callback", methods=["GET"])
def kakao_callback():
    code  = request.args.get("code")
    state = request.args.get("state") or ""
    if not code:
        return redirect("iotapp://login_oauth?error=code_missing")
    if not STATE_RE.fullmatch(state):
        return redirect("iotapp://login_oauth?error=state_invalid")

    token_resp = requests.post(
        KAKAO_TOKEN_URL,
        data={
            "grant_type":    "authorization_code",
            "client_id":     os.environ["KAKAO_CLIENT_ID"],
            "client_secret": os.environ.get("KAKAO_CLIENT_SECRET", ""),
            "redirect_uri":  os.environ["KAKAO_REDIRECT_URI"],
            "code":          code,
        },
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=10,
    )
    if not token_resp.ok:
        return redirect("iotapp://login_oauth?error=token_exchange_failed")

    token_data   = token_resp.json()
    access_token = token_data["access_token"]
    expires_at   = datetime.now(timezone.utc) + timedelta(seconds=token_data.get("expires_in", 21600))

    user_resp = requests.get(
        KAKAO_USER_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10,
    )
    if not user_resp.ok:
        return redirect("iotapp://login_oauth?error=userinfo_failed")

    kakao_info    = user_resp.json()
    kakao_user_id = kakao_info["id"]
    kakao_name    = kakao_info.get("properties", {}).get("nickname", f"kakao_{kakao_user_id}")

    with _db.Session() as session:
        oauth_row = session.query(KakaoOAuthToken).filter_by(kakao_user_id=kakao_user_id).first()

        if oauth_row is None:
            new_user = User(
                user_uuid  = str(uuid.uuid4()),
                user_name  = kakao_name,
                secret_key = "",
            )
            session.add(new_user)
            session.flush()

            oauth_row = KakaoOAuthToken(
                user_uuid     = new_user.user_uuid,
                kakao_user_id = kakao_user_id,
                access_token  = access_token,
                refresh_token = token_data.get("refresh_token"),
                expires_at    = expires_at,
                scope         = token_data.get("scope"),
            )
            session.add(oauth_row)
        else:
            oauth_row.access_token  = access_token
            oauth_row.refresh_token = token_data.get("refresh_token", oauth_row.refresh_token)
            oauth_row.expires_at    = expires_at
            oauth_row.updated_at    = datetime.now(timezone.utc)

        login_code = secrets.token_urlsafe(32)
        session.add(OAuthLoginCode(
            code       = login_code,
            user_uuid  = oauth_row.user_uuid,
            state      = state,
            expired_at = datetime.now(timezone.utc) + LOGIN_CODE_TTL,
        ))
        session.commit()
        user_uuid = oauth_row.user_uuid
        log_activity("user_login", user_uuid=user_uuid)

    # 커스텀 scheme은 다른 앱도 등록할 수 있어 토큰을 URL에 싣지 않는다. 앱이 HTTPS로 교환한다.
    return redirect(f"iotapp://login_oauth?code={login_code}&state={state}")


# POST /auth/kakao/exchange  { "code": "...", "verifier": "..." }
@kakao_bp.route("/kakao/exchange", methods=["POST"])
def kakao_exchange():
    data     = request.get_json(silent=True) or {}
    code     = data.get("code")
    verifier = data.get("verifier")
    if not isinstance(code, str) or not isinstance(verifier, str):
        return jsonify({"error": "invalid payload"}), 400

    with _db.Session() as session:
        row = session.get(OAuthLoginCode, code)
        if row is None:
            return jsonify({"error": "invalid code"}), 400

        # 일회용: 검증 결과와 무관하게 지운다
        user_uuid = row.user_uuid
        valid = (row.expired_at.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc)
                 and hmac.compare_digest(hashlib.sha256(verifier.encode()).hexdigest(), row.state))
        session.delete(row)
        if not valid:
            session.commit()
            return jsonify({"error": "invalid code"}), 400

        access_token, refresh_token = issue_token_pair(user_uuid, session=session)
        session.commit()

    return jsonify({"access_token": access_token, "refresh_token": refresh_token, "user_uuid": user_uuid}), 200


