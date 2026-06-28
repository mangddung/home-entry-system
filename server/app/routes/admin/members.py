import os
import uuid
from functools import wraps

from flask import Blueprint, request, jsonify
from cryptography.fernet import Fernet

from app.utils.database import database as _db
from app.utils.database.models import User, UserDeviceMapping
from app.routes.client.auth import issue_token_pair

admin_member_bp = Blueprint("admin_member", __name__, url_prefix="/admin")


def _require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        key = request.headers.get("X-Admin-Key", "")
        if not key or key != os.environ.get("ADMIN_SECRET", ""):
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated


DUMMY_USERS = [
    ("member1", "member"),
    ("member2", "member"),
    ("guest1",  "guest"),
    ("guest2",  "guest"),
]


def _generate_user_secret() -> str:
    raw_key = os.urandom(16)
    return Fernet(os.environ["MASTER_KEK"].encode()).encrypt(raw_key.hex().encode()).decode()


# POST /admin/users
@admin_member_bp.route("/users", methods=["POST"])
@_require_admin
def create_dummy_user():
    data  = request.get_json(silent=True) or {}
    count = int(data.get("count", 1))

    created = []
    with _db.Session() as session:
        for _ in range(count):
            user = User(
                user_uuid=str(uuid.uuid4()),
                user_name=f"dummy_{uuid.uuid4().hex[:8]}",
                secret_key=_generate_user_secret(),
            )
            session.add(user)
            session.flush()
            created.append({"user_uuid": user.user_uuid, "user_name": user.user_name})
        session.commit()

    return jsonify({"status": "success", "users": created}), 201


# GET /admin/users
@admin_member_bp.route("/users", methods=["GET"])
@_require_admin
def list_users():
    with _db.Session() as session:
        users = session.query(User).all()
        result = [{"user_uuid": u.user_uuid, "user_name": u.user_name} for u in users]

    return jsonify({"users": result}), 200


# POST /admin/login
@admin_member_bp.route("/login", methods=["POST"])
@_require_admin
def admin_login():
    data      = request.get_json(silent=True) or {}
    user_uuid = (data.get("user_uuid") or "").strip()

    if not user_uuid:
        return jsonify({"error": "missing user_uuid"}), 400

    with _db.Session() as session:
        user = session.query(User).filter_by(user_uuid=user_uuid).first()
        if not user:
            return jsonify({"error": "user not found"}), 404
        access_token, refresh_token = issue_token_pair(user_uuid, session=session)
        session.commit()

    return jsonify({"access_token": access_token, "refresh_token": refresh_token}), 200


# POST /admin/members/dummy
@admin_member_bp.route("/members/dummy", methods=["POST"])
@_require_admin
def add_dummy_members():
    with _db.Session() as session:
        master_device_uuids = [
            m.device_uuid for m in
            session.query(UserDeviceMapping).filter_by(role="master").all()
        ]
        if not master_device_uuids:
            return jsonify({"error": "no devices with master found"}), 404

        dummy_users = {}
        for name, role in DUMMY_USERS:
            user = session.query(User).filter_by(user_name=name).first()
            if user is None:
                user = User(
                    user_uuid=str(uuid.uuid4()),
                    user_name=name,
                    secret_key=_generate_user_secret(),
                )
                session.add(user)
                session.flush()
            dummy_users[name] = (user, role)

        for device_uuid in master_device_uuids:
            for name, (user, role) in dummy_users.items():
                exists = session.query(UserDeviceMapping).filter_by(
                    user_uuid=user.user_uuid, device_uuid=device_uuid
                ).first()
                if not exists:
                    session.add(UserDeviceMapping(
                        user_uuid=user.user_uuid,
                        device_uuid=device_uuid,
                        display_name=name,
                        role=role,
                    ))

        session.commit()

    return jsonify({"status": "success", "devices": master_device_uuids}), 201
