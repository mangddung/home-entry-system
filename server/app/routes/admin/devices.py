import hmac
import os
import re
import secrets
import uuid
from datetime import datetime, timezone
from functools import wraps

from flask import Blueprint, request, jsonify
import jwt
from cryptography.fernet import Fernet

from app.utils.database import database as _db
from app.utils.database.models import DeviceManagement, Gateway
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



MODELS = ("wifi", "zigbee")
IEEE_RE = re.compile(r"0x[0-9a-f]{16}")


# POST /admin/devices  { "model": "wifi"|"zigbee", "ieee_addr": "0x<16 hex>" }  (gen_config가 호출)
# body가 없으면 기존처럼 Wi-Fi 모델로 만든다.
@admin_bp.route("/devices", methods=["POST"])
@_require_admin
def register_device():
    data      = request.get_json(silent=True) or {}
    transport = data.get("model") or "wifi"
    ieee_addr = (data.get("ieee_addr") or "").strip().lower() or None
    if transport not in MODELS or (ieee_addr and not IEEE_RE.fullmatch(ieee_addr)):
        return jsonify({"error": "invalid model or ieee_addr"}), 400
    if transport == "zigbee" and not ieee_addr:
        return jsonify({"error": "zigbee model requires ieee_addr"}), 400

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
        transport             = transport,
        ieee_addr             = ieee_addr,
    )

    replaced = None
    with _db.Session() as session:
        # 같은 칩을 다시 플래시하면(erase-flash) 이전 기기는 더 쓸 수 없으므로 정리한다
        old = session.query(DeviceManagement).filter_by(ieee_addr=ieee_addr).first() if ieee_addr else None
        if old:
            replaced = old.device_uuid
            session.delete(old)
            session.flush()
        session.add(device)
        session.commit()

    return jsonify({
        "device_uuid":       device_uuid,
        "device_secret_key": raw_secret_hex,
        "device_token":      device_token,
        "setup_token":       setup_token,
        "replaced_device_uuid": replaced,
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


# POST /admin/gateways  { "gateway_id": "..." }  — 게이트웨이 등록(현 단계: Zigbee2MQTT, gateway/add_gateway.ps1이 호출)
# MQTT 계정은 Mosquitto 비밀번호 파일에서 따로 만든다.
@admin_bp.route("/gateways", methods=["POST"])
@_require_admin
def register_gateway():
    gateway_id = ((request.get_json(silent=True) or {}).get("gateway_id") or "").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,48}", gateway_id):
        return jsonify({"error": "invalid gateway_id"}), 400
    with _db.Session() as session:
        if not session.get(Gateway, gateway_id):
            session.add(Gateway(gateway_id=gateway_id))
            session.commit()
    return jsonify({"status": "success", "gateway_id": gateway_id}), 201
