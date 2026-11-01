"""Zigbee 모델 MQTT 워커(mqtt_worker.handle) 흐름 확인. 임시 DB만 사용, 브로커·네트워크 없음."""
import os, sys, tempfile, pathlib, datetime, hashlib
from dotenv import load_dotenv
from cryptography.fernet import Fernet

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()
os.environ["MASTER_KEK"] = Fernet.generate_key().decode()
os.environ.setdefault("JWT_SECRET", "test-secret")

from app.utils.database import database as _db

tmpdir = pathlib.Path(tempfile.mkdtemp())
_db._DATA_DIR = tmpdir
_db._DB_PATH = tmpdir / "app.db"
_db.init_db()

from app.utils.database.models import DeviceManagement, Gateway, UserDeviceMapping, User
from app.routes.iot import init as iot
import mqtt_worker as w

pushed = []
iot.send_to_user = lambda *a, **k: pushed.append(a)
iot.send_to_device_master = lambda *a, **k: pushed.append(a)

USER, DEV, IEEE, GW, EVIL_GW = "u-1", "dev-zb", "0xe8f60afffefc97e0", "gw-dev", "gw-evil"
TOKEN = "setup-token-abc"
SECRET_HEX = "00112233445566778899aabbccddeeff"   # gen_config가 펌웨어에 굽는 IOT_DEVICE_SECRET_KEY 형식
KEY = bytes.fromhex(SECRET_HEX)

with _db.Session() as s:
    s.add(User(user_uuid=USER, user_name="user", secret_key="x"))
    s.add(Gateway(gateway_id=GW))
    s.add(Gateway(gateway_id=EVIL_GW))
    s.add(DeviceManagement(device_uuid=DEV, device_token="t", setup_token=TOKEN,
                           device_secret_key=Fernet(os.environ["MASTER_KEK"].encode()).encrypt(SECRET_HEX.encode()).decode(),
                           ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w", ble_manufacturer_uuid="m",
                           transport="zigbee", ieee_addr=IEEE,
                           setup_user_uuid=USER, setup_requested_at=datetime.datetime.utcnow()))
    s.commit()


def row():
    with _db.Session() as s:
        d = s.query(DeviceManagement).filter_by(device_uuid=DEV).one()
        s.expunge(d)
        return d


def send(gw, mtype, seq, body=b"", key=KEY):
    """기기처럼 태그를 붙여 보내고, 응답 태그를 검증해 [type][seq][data]만 돌려준다."""
    req = bytes([mtype, seq]) + body
    rsp = w.handle(gw, IEEE, req + w.tag(key, req))
    if rsp is None:
        return None
    data, t = rsp[:-w.TAG_LEN], rsp[-w.TAG_LEN:]
    assert t == w.tag(KEY, req + data), "response tag must bind to the request"
    return data


# UUID 유도 규칙: 펌웨어 derive_uuid와 같은 비트 (버전 4, RFC 4122 variant)
seed = bytes(range(16))
u = w.derive_ble_uuids(seed)
h = bytearray(hashlib.sha256(seed + b"\x00").digest()[:16])
h[6] = (h[6] & 0x0F) | 0x40
h[8] = (h[8] & 0x3F) | 0x80
assert u[0].replace("-", "") == h.hex(), (u[0], h.hex())
assert len(set(u)) == 4
print("[ok] seed → BLE UUID 유도가 펌웨어 규칙과 같다")

# 미등록 기기: 아직 마스터가 없으니 registered=0
assert send(GW, w.PING, 1, b"\x00rand") == bytes([w.PING_RESULT, 1, 0])
assert row().last_ping_at is not None and row().gateway_id is None
print("[ok] ping이 생존 시각을 기록하고 미등록이면 registered=0 (게이트웨이는 아직 안 묶임)")

assert send("gw-unknown", w.PING, 100, b"\x00rand") is None
print("[ok] 등록되지 않은 게이트웨이의 메시지는 무시")

assert send(GW, w.PING, 101, b"\x00rand", key=b"\x00" * 16) is None
print("[ok] 기기 키가 아닌 태그(위조 요청)는 무시")

# 틀린 셋업 토큰 → 실패
assert send(GW, w.VALIDATE_SETUP, 2, b"wrong") == bytes([w.SETUP_RESULT, 2, w.STATUS_FAIL])
print("[ok] 틀린 셋업 토큰은 거부")

# 맞는 토큰 → 등록, seed로 만든 UUID가 DB에 들어가고 하드웨어 정보는 보존
rsp = send(GW, w.VALIDATE_SETUP, 3, TOKEN.encode())
assert rsp[:3] == bytes([w.SETUP_RESULT, 3, w.STATUS_OK]) and len(rsp) == 3 + 16, rsp
uuids = w.derive_ble_uuids(rsp[3:])
d = row()
assert (d.ble_service_uuid, d.ble_read_uuid, d.ble_write_uuid, d.ble_manufacturer_uuid) == uuids
assert (d.transport, d.ieee_addr, d.gateway_id) == ("zigbee", IEEE, GW), (d.transport, d.ieee_addr, d.gateway_id)
assert d.setup_token != TOKEN
with _db.Session() as s:
    assert s.query(UserDeviceMapping).filter_by(device_uuid=DEV, user_uuid=USER, role="master").one()
print("[ok] 셋업 성공: 마스터 등록, seed UUID 저장, transport·ieee_addr 보존, 게이트웨이에 묶임")

# 응답을 못 받은 기기가 같은 토큰으로 다시 보내면 같은 결과(새 seq)
assert send(GW, w.VALIDATE_SETUP, 4, TOKEN.encode()) == bytes([w.SETUP_RESULT, 4]) + rsp[2:]
print("[ok] 셋업 재요청은 같은 결과를 돌려준다")

# 다른 게이트웨이로 들어온 메시지(키를 알아도)는 버린다
assert send(EVIL_GW, w.RESET, 50) is None
with _db.Session() as s:
    assert s.query(UserDeviceMapping).filter_by(device_uuid=DEV, role="master").one()
print("[ok] 다른 게이트웨이로 들어온 RESET은 무시(마스터 유지)")

# 같은 메시지 재수신은 무시 (Z2M 상태 재발행 등)
assert send(GW, w.VALIDATE_SETUP, 4, TOKEN.encode()) is None
print("[ok] 중복 메시지는 처리하지 않는다")

# 등록 후 부팅 ping → registered=1 + 전원 켜짐 알림
pushed.clear()
assert send(GW, w.PING, 5, b"\x01rand") == bytes([w.PING_RESULT, 5, 1])
assert any("기기 전원이 켜졌습니다" in a for a in pushed), pushed
print("[ok] 부팅 ping은 registered=1 + 전원 켜짐 알림")

# 인증 메시지: 길이가 틀리면 실패, 같은 nonce 재사용은 실패
assert send(GW, w.VALIDATE_TOKEN, 6, b"\x00" * 10) == bytes([w.AUTH_RESULT, 6, w.STATUS_FAIL])
nonce = bytes(range(8))
send(GW, w.VALIDATE_TOKEN, 7, nonce + b"\x11" * 32)     # 첫 사용(이 테스트에선 mac이 틀려 실패하지만 nonce는 소모)
assert send(GW, w.VALIDATE_TOKEN, 8, nonce + b"\x22" * 32) == bytes([w.AUTH_RESULT, 8, w.STATUS_FAIL])
print("[ok] 잘못된 인증 메시지·nonce 재사용은 실패 응답")

# BOOT 버튼 리셋 → 미등록으로, 하드웨어 정보 보존, 게이트웨이 묶음 해제
assert send(GW, w.RESET, 9) == bytes([w.RESET_RESULT, 9, w.STATUS_OK])
d = row()
assert (d.transport, d.ieee_addr, d.gateway_id) == ("zigbee", IEEE, None)
assert send(GW, w.PING, 10, b"\x00rand") == bytes([w.PING_RESULT, 10, 0])
print("[ok] 리셋 후 미등록 상태, transport·ieee_addr 보존, 게이트웨이 묶음 해제")

# 등록되지 않은 IEEE는 응답하지 않는다
assert w.handle(GW, "0x0000000000000001", bytes([w.PING, 11, 0]) + b"\x00" * 8) is None
print("[ok] 모르는 IEEE는 무시")

print("\n전체 통과")
