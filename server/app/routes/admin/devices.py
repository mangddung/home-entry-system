import hmac
import os
import secrets
import uuid
from datetime import datetime, timezone
from functools import wraps

from flask import Blueprint, request, jsonify
import jwt
from cryptography.fernet import Fernet

from app.utils.database import database as _db
from app.utils.database.models import DeviceManagement
from app.utils.device_utils import _generate_device_secret, _issue_device_jwt

admin_bp = Blueprint("admin", __name__, url_prefix="/admin")


def _require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        key = request.headers.get("X-Admin-Key", "")
        if not key or not hmac.compare_digest(key, os.environ.get("ADMIN_SECRET", "")):
            return jsonify({"error": "unauthorized"}), 401
        return f(*args, **kwargs)
    return decorated



# POST /admin/devices
@admin_bp.route("/devices", methods=["POST"])
@_require_admin
def register_device():
    device_uuid           = str(uuid.uuid4())
    ble_service_uuid      = str(uuid.uuid4())
    ble_write_uuid        = str(uuid.uuid4())
    ble_read_uuid         = str(uuid.uuid4())
    ble_manufacturer_uuid = str(uuid.uuid4())
    raw_secret_hex, enc_secret = _generate_device_secret()
    device_jti = str(uuid.uuid4())
    device_token = _issue_device_jwt(
        device_uuid, ble_service_uuid, ble_read_uuid, ble_write_uuid, ble_manufacturer_uuid, jti=device_jti
    )
    setup_token = secrets.token_urlsafe(32)

    device = DeviceManagement(
        device_uuid           = device_uuid,
        device_secret_key     = enc_secret,
        device_token          = device_token,
        setup_token           = setup_token,
        ble_service_uuid      = ble_service_uuid,
        ble_write_uuid        = ble_write_uuid,
        ble_read_uuid         = ble_read_uuid,
        ble_manufacturer_uuid = ble_manufacturer_uuid,
        current_jti           = device_jti,
    )

    with _db.Session() as session:
        session.add(device)
        session.commit()

    return jsonify({
        "device_uuid":       device_uuid,
        "device_secret_key": raw_secret_hex,
        "device_token":      device_token,
        "setup_token":       setup_token,
    }), 201


# DELETE /admin/devices/<device_uuid>
@admin_bp.route("/devices/<device_uuid>", methods=["DELETE"])
@_require_admin
def delete_device(device_uuid):
    with _db.Session() as session:
        device = session.query(DeviceManagement).filter_by(device_uuid=device_uuid).first()
        if device is None:
            return jsonify({"error": "device not found"}), 404
        session.delete(device)
        session.commit()

    return jsonify({"status": "success"}), 200
