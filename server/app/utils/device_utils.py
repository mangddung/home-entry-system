import os
from datetime import datetime, timezone
from functools import wraps

import jwt
from cryptography.fernet import Fernet

from app.utils.database import database as _db
from app.utils.database.models import DeviceManagement

def _generate_device_secret() -> tuple[str, str]:
    """AES-16바이트 키 생성 후 MASTER_KEK으로 Fernet 암호화.
    Returns (raw_hex, encrypted_for_db)"""
    master_kek = os.environ["MASTER_KEK"].encode()
    raw_key = os.urandom(16)
    raw_hex = raw_key.hex()
    encrypted = Fernet(master_kek).encrypt(raw_hex.encode()).decode()
    return raw_hex, encrypted


def _issue_device_jwt(device_uuid: str, ble_service_uuid: str, ble_read_uuid: str,
                      ble_write_uuid: str, ble_manufacturer_uuid: str) -> str:
    payload = {
        "sub":              device_uuid,
        "type":             "device",
        "ble_service_uuid": ble_service_uuid,
        "ble_read_uuid":    ble_read_uuid,
        "ble_write_uuid":   ble_write_uuid,
        "manufacturer_uuid": ble_manufacturer_uuid,
        "iat":              datetime.now(timezone.utc),
    }
    return jwt.encode(payload, os.environ["JWT_SECRET"], algorithm="HS256")