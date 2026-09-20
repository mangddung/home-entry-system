import uuid
import os
import requests
from datetime import datetime, timedelta, timezone

from flask import Blueprint, request, jsonify, redirect

from app.utils.database import database as _db
from app.utils.database import User, KakaoOAuthToken
from app.routes.client.auth import issue_token_pair
from app.utils.log_utils import log_activity
from app.utils.limiter import limiter

kakao_bp = Blueprint("kakao", __name__, url_prefix="/auth")
limiter.limit("10/minute")(kakao_bp)

KAKAO_TOKEN_URL = "https://kauth.kakao.com/oauth/token"
KAKAO_USER_URL  = "https://kapi.kakao.com/v2/user/me"


# GET /auth/kakao/config
@kakao_bp.route("/kakao/config", methods=["GET"])
def kakao_config():
    return jsonify({
        "client_id":    os.environ["KAKAO_CLIENT_ID"],
        "redirect_uri": os.environ["KAKAO_REDIRECT_URI"],
    })


# GET /auth/kakao/callback?code=...
@kakao_bp.route("/kakao/callback", methods=["GET"])
def kakao_callback():
    code = request.args.get("code")
    if not code:
        return redirect("iotapp://login_oauth?error=code_missing")

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

        session.commit()
        user_uuid = oauth_row.user_uuid
        log_activity("user_login", user_uuid=user_uuid)

    access_token, refresh_token = issue_token_pair(user_uuid)
    return redirect(
        f"iotapp://login_oauth"
        f"?access_token={access_token}"
        f"&refresh_token={refresh_token}"
        f"&user_uuid={user_uuid}"
    )


