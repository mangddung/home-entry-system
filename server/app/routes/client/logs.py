from flask import Blueprint, request, jsonify

from app.utils.database import database as _db
from app.utils.database.models import ActivityLog, UserDeviceMapping
from app.routes.client.auth import verify_access_token

logs_bp = Blueprint("logs", __name__, url_prefix="/client")

CATEGORY_PATTERNS = {
    "device": "device_%",
    "access": "token_validated",
    "member": "member_%",
}

EXCLUDED_ACTIONS = [
    "device_ping",
]

# GET /client/logs
@logs_bp.route("/logs", methods=["GET"])
def get_logs():
    payload, err = verify_access_token(request.headers.get("Authorization", ""))
    if err:
        return jsonify({"status": "error", "message": "invalid token"}), 401

    user_uuid   = payload["sub"]
    device_uuid = (request.args.get("device_uuid") or "").strip()
    category    = (request.args.get("category") or "").strip()

    if not device_uuid:
        return jsonify({"status": "error", "message": "invalid payload"}), 400

    with _db.Session() as session:
        master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid, role="master").first()
        if not master:
            return jsonify({"status": "error", "message": "forbidden"}), 403

        query = session.query(ActivityLog).filter(
            ActivityLog.device_uuid == device_uuid,
            ActivityLog.action.notin_(EXCLUDED_ACTIONS)
        )

        if category in CATEGORY_PATTERNS:
            pattern = CATEGORY_PATTERNS[category]
            if "%" in pattern:
                query = query.filter(ActivityLog.action.like(pattern))
            else:
                query = query.filter(ActivityLog.action == pattern)

        logs = query.order_by(ActivityLog.created_at.desc()).all()

        mappings = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid).all()
        display_name_map = {m.user_uuid: m.display_name for m in mappings}

        data = [{
            "id":           l.id,
            "action":       l.action,
            "user_uuid":    l.user_uuid,
            "display_name": display_name_map.get(l.user_uuid) if l.user_uuid else None,
            "detail":       l.detail,
            "created_at":   l.created_at.isoformat() + "Z" if l.created_at else None,
        } for l in logs]

        return jsonify({"status": "success", "data": data}), 200
