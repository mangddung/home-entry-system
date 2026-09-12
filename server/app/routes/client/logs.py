import json

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


def _display_name(user_uuid, detail, name_map):
    """이름은 매핑에서 읽지만, 탈퇴·추방으로 매핑이 사라진 사용자는 로그에 남은 이름으로 채운다."""
    if not user_uuid:
        return None
    if name_map.get(user_uuid):
        return name_map[user_uuid]
    try:
        name = (json.loads(detail) or {}).get("display_name") if detail else None
    except (ValueError, TypeError):
        name = None
    return name or f"탈퇴한 사용자({user_uuid[:8]})"

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
        mapping = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, user_uuid=user_uuid).first()
        if not mapping:
            return jsonify({"status": "error", "message": "forbidden"}), 403

        query = session.query(ActivityLog).filter(
            ActivityLog.device_uuid == device_uuid,
            ActivityLog.action.notin_(EXCLUDED_ACTIONS)
        )

        # 마스터가 아니면 카테고리와 무관하게 본인 출입 기록만 본다(프런트 탭이 아니라 여기서 막는다)
        if mapping.role != "master":
            query = query.filter(
                ActivityLog.action == CATEGORY_PATTERNS["access"],
                ActivityLog.user_uuid == user_uuid,
            )
        elif category in CATEGORY_PATTERNS:
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
            "display_name": _display_name(l.user_uuid, l.detail, display_name_map),
            "detail":       l.detail,
            "created_at":   l.created_at.isoformat() + "Z" if l.created_at else None,
        } for l in logs]

        return jsonify({"status": "success", "data": data}), 200
