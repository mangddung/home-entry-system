"""Zigbee 모델용 MQTT 워커 — Flask(gunicorn)와 분리된 단일 프로세스로 실행한다: python mqtt_worker.py

게이트웨이(Zigbee2MQTT, base_topic = homes/<gateway_id>)가 기기 메시지를 homes/<gateway_id>/<friendly_name> 로 발행하면
doorlock_req(hex)를 해석해 HTTP 기기 API(app/routes/iot/init.py)와 같은 로직으로 처리하고
homes/<gateway_id>/<friendly_name>/set 에 {"doorlock_rsp": hex} 로 응답한다.

메시지 = [type][seq][data...][tag(8)]  — 형식은 esp32/main/transport_zigbee.c, gateway/z2m/data/external_converters/doorlock.mjs와 짝.
  tag = HMAC-SHA256(기기 비밀키)[:8]. 요청: HMAC(req), 응답: HMAC(req(태그 제외) || rsp) — 응답이 요청에 묶인다.
기기는 IEEE 주소(Z2M include_device_information의 device.ieeeAddr = gen_config가 등록한 ieee_addr)로 식별한다.
"""
from dotenv import load_dotenv
load_dotenv()

import hashlib
import hmac
import json
import logging
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import firebase_admin
from firebase_admin import credentials
import paho.mqtt.client as mqtt

from app.utils.crypto_utils import decrpyt_key
from app.utils.database import database as _db
from app.utils.database import init_db
from app.utils.database.models import DeviceManagement, Gateway, UserDeviceMapping
from app.utils.mqtt_utils import mqtt_settings
from app.routes.iot import init as iot

log = logging.getLogger("mqtt_worker")

PING, VALIDATE_TOKEN, VALIDATE_SETUP, RESET = 0x01, 0x02, 0x03, 0x04
PING_RESULT, AUTH_RESULT, SETUP_RESULT, RESET_RESULT = 0x81, 0x82, 0x83, 0x84
STATUS_OK, STATUS_FAIL = 0, 1
TAG_LEN = 8

DEDUP_TTL = 120          # 같은 요청이 다시 오면(재전송·Z2M 상태 재발행) 무시
NONCE_TTL = 24 * 3600    # 근접 열기 nonce는 한 번만 받는다(옛 인증 요청 재사용 차단)
SETUP_CACHE_TTL = 600    # 셋업 재요청에 같은 결과를 돌려준다(기기는 응답을 못 받으면 같은 토큰으로 다시 보낸다)

_seen: dict[tuple, float] = {}
_used_nonces: dict[tuple, float] = {}
_setup_results: dict[tuple, tuple[float, bytes]] = {}


def derive_ble_uuids(seed: bytes) -> tuple[str, str, str, str]:
    """기기(transport_zigbee.c derive_uuid)와 같은 규칙: uuid_i = SHA256(seed || i)[0:16], 버전 4."""
    return tuple(str(uuid.UUID(bytes=hashlib.sha256(seed + bytes([i])).digest()[:16], version=4)) for i in range(4))


def tag(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()[:TAG_LEN]


def _once(store: dict, key: tuple, ttl: float) -> bool:
    """처음 보는 key면 True. ponytail: 프로세스 메모리라 워커 재시작 시 초기화된다."""
    now = time.monotonic()
    for k in [k for k, t in store.items() if now - t > ttl]:
        del store[k]
    if key in store:
        return False
    store[key] = now
    return True


def _touch(ieee: str, gateway_id: str) -> tuple[str, bytes] | None:
    """기기 행을 찾아 생존 시각을 기록하고 (device_uuid, 메시지 키)를 돌려준다. Zigbee 모델로 등록된 기기만 받는다.
    등록(셋업)된 기기는 셋업을 중계한 게이트웨이에 묶인다. 다른 게이트웨이 계정이 같은 IEEE로 보낸
    메시지는 버린다. 미등록 기기는 셋업 토큰 없이는 할 수 있는 게 없어 아무 게이트웨이나 받는다."""
    with _db.Session() as session:
        if session.get(Gateway, gateway_id) is None:
            log.warning("message from unregistered gateway %s", gateway_id)
            return None
        device = session.query(DeviceManagement).filter_by(ieee_addr=ieee, transport="zigbee").first()
        if device is None:
            log.warning("unknown zigbee device %s on %s", ieee, gateway_id)
            return None
        if device.gateway_id and device.gateway_id != gateway_id:
            log.warning("device %s is bound to %s – message via %s dropped", ieee, device.gateway_id, gateway_id)
            return None
        try:
            key = bytes.fromhex(decrpyt_key(os.environ["MASTER_KEK"], device.device_secret_key))
        except Exception:
            log.error("device %s secret unreadable", ieee)
            return None
        device.last_ping_at = datetime.now(timezone.utc)
        device_uuid = device.device_uuid
        session.commit()
        return device_uuid, key


def handle(gateway_id: str, ieee: str, msg: bytes) -> bytes | None:
    """기기 요청 하나(태그 포함)를 처리해 응답 메시지(태그 포함)를 돌려준다. 응답할 것이 없으면 None."""
    if len(msg) < 2 + TAG_LEN:
        return None
    req, req_tag = msg[:-TAG_LEN], msg[-TAG_LEN:]
    mtype, seq, body = req[0], req[1], req[2:]

    found = _touch(ieee, gateway_id)
    if found is None:
        return None
    device_uuid, key = found
    if not hmac.compare_digest(req_tag, tag(key, req)):
        log.warning("bad tag from %s (type 0x%02x) – dropped", ieee, mtype)
        return None
    if not _once(_seen, (ieee, msg), DEDUP_TTL):
        return None

    def reply(rsp_type: int, data: bytes) -> bytes:
        rsp = bytes([rsp_type, seq]) + data
        return rsp + tag(key, req + rsp)

    if mtype == PING:
        # body = [flags][rand(4)][셀 전압 mV little-endian(2)]. 0이면 셀 없음, 짧으면 전압을 안 싣는 옛 펌웨어
        iot.save_battery(device_uuid, int.from_bytes(body[5:7], "little") if len(body) >= 7 else None)
        registered = iot.is_registered(device_uuid)
        if body[:1] and body[0] & 0x01 and registered:
            with _db.Session() as session:
                m = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()
                nickname = (m.device_nickname or device_uuid[:8]) if m else device_uuid
            iot.notify_power_on(device_uuid, nickname)
        return reply(PING_RESULT, bytes([1 if registered else 0]))

    if mtype == VALIDATE_TOKEN:
        if len(body) != 8 + 32 or not _once(_used_nonces, (device_uuid, body[:8]), NONCE_TTL):
            return reply(AUTH_RESULT, bytes([STATUS_FAIL]))
        # ponytail: HTTP 경로의 20/min 제한이 없다. 시도마다 BLE 연결·새 nonce가 필요해 우선 생략.
        _, status = iot.validate_mac(device_uuid, body[8:].hex(), body[:8].hex())
        return reply(AUTH_RESULT, bytes([STATUS_OK if status == 200 else STATUS_FAIL]))

    if mtype == VALIDATE_SETUP:
        setup_token = body.decode("ascii", errors="replace")
        cached = _setup_results.get((ieee, setup_token))
        if cached and time.monotonic() - cached[0] < SETUP_CACHE_TTL:
            return reply(SETUP_RESULT, cached[1])
        with _db.Session() as session:
            row = session.query(DeviceManagement).filter_by(device_uuid=device_uuid, setup_token=setup_token).first()
            if row is None:
                result = bytes([STATUS_FAIL])
            else:
                seed = os.urandom(16)
                row.gateway_id = gateway_id  # 이 게이트웨이에 묶는다(complete_setup이 새 행으로 옮긴다)
                # ponytail: install code 전에는 가입 시점에 근처의 다른 열린 네트워크로 붙을 수 있다. 기기별 링크 키 단계에서 보완.
                _, status = iot.complete_setup(session, row, ble_uuids=derive_ble_uuids(seed))
                result = bytes([STATUS_OK]) + seed if status == 200 else bytes([STATUS_FAIL])
        if result[0] == STATUS_OK:
            _setup_results[(ieee, setup_token)] = (time.monotonic(), result)
        return reply(SETUP_RESULT, result)

    if mtype == RESET:
        _, status = iot.reset_device(device_uuid)
        return reply(RESET_RESULT, bytes([STATUS_OK if status == 200 else STATUS_FAIL]))

    log.warning("unknown message type 0x%02x from %s", mtype, ieee)
    return None


def on_connect(client, userdata, flags, reason_code, properties):
    log.info("MQTT connected (%s)", reason_code)
    client.subscribe("homes/+/+", qos=1)  # 기기 상태: homes/<gw>/<friendly_name>


def on_message(client, userdata, message):
    parts = message.topic.split("/")
    if len(parts) != 3 or parts[0] != "homes":
        return
    gateway_id, name = parts[1], parts[2]
    try:
        payload = json.loads(message.payload)
    except ValueError:
        return
    if not isinstance(payload, dict) or not isinstance(payload.get("doorlock_req"), str):
        return
    # friendly name은 Z2M에서 바뀔 수 있어 include_device_information의 IEEE를 우선 쓴다
    device_info = payload.get("device") if isinstance(payload.get("device"), dict) else {}
    ieee = str(device_info.get("ieeeAddr") or name).lower()
    try:
        msg = bytes.fromhex(payload["doorlock_req"])
    except ValueError:
        log.warning("bad doorlock_req from %s", name)
        return
    try:
        rsp = handle(gateway_id, ieee, msg)
    except Exception:
        log.exception("handling message from %s failed", ieee)
        return
    if rsp is not None:
        client.publish(f"homes/{gateway_id}/{name}/set", json.dumps({"doorlock_rsp": rsp.hex()}), qos=1)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    firebase_admin.initialize_app(credentials.Certificate(os.getenv("FIREBASE_CREDENTIAL_PATH")))
    init_db()

    # 메시지 처리 스레드가 FCM 푸시를 기다리지 않게 한다(느려지면 기기의 인증 응답 대기 8초를 넘긴다)
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="fcm")
    for name in ("send_to_user", "send_to_device_master"):
        fn = getattr(iot, name)
        setattr(iot, name, lambda *a, _fn=fn, **k: pool.submit(_fn, *a, **k))

    cfg = mqtt_settings()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="doorlock-server-worker")
    client.username_pw_set(cfg["auth"]["username"], cfg["auth"]["password"])
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect_async(cfg["hostname"], cfg["port"])
    client.loop_forever(retry_first_connection=True)


if __name__ == "__main__":
    main()
