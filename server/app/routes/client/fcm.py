from flask import Blueprint, request, jsonify

from app.utils.database import database as _db
from app.utils.database.models import User
from app.routes.client.auth import verify_access_token

fcm_bp = Blueprint("fcm", __name__, url_prefix="/client")

# POST /client/fcm-token
@fcm_bp.route("/fcm-token", methods=["POST"])
def register_fcm_token():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    data = request.get_json(silent=True) or {}
    fcm_token = (data.get("fcm_token") or "").strip()

    if not fcm_token:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    with _db.Session() as session:
        user = session.query(User).filter_by(user_uuid=user_uuid).first()
        if not user:
            return jsonify({"status": "error", "message": "user not found"}), 404

        user.fcm_token = fcm_token
        session.commit()

    return jsonify({"status": "ok"}), 200


# DELETE /client/fcm-token
@fcm_bp.route("/fcm-token", methods=["DELETE"])
def revoke_fcm_token():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid = payload["sub"]

    with _db.Session() as session:
        user = session.query(User).filter_by(user_uuid=user_uuid).first()
        if not user:
            return jsonify({"status": "error", "message": "user not found"}), 404

        user.fcm_token = None
        session.commit()

    return jsonify({"status": "ok"}), 200
