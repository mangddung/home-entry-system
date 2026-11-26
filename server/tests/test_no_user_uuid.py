"""user_uuid를 받지 않는 인증/설정 플로우 테스트. 임시 DB만 사용, 네트워크 없음."""
import os, sys, tempfile, pathlib, datetime, uuid
from dotenv import load_dotenv

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()

from cryptography.fernet import Fernet
os.environ["JWT_SECRET"] = "test-secret"
os.environ["MASTER_KEK"] = Fernet.generate_key().decode()  # 임시 DB 전용 키
for k in ("SETUP_SERVICE_UUID", "SETUP_WRITE_UUID", "SETUP_READ_UUID"):
    os.environ.setdefault(k, "x")

from app.utils.database import database as _db

tmpdir = pathlib.Path(tempfile.mkdtemp())
_db._DATA_DIR = tmpdir
_db._DB_PATH = tmpdir / "app.db"
_db.init_db()

import jwt
from flask import Flask
from app.utils.database.models import DeviceManagement, UserDeviceMapping, User, UserToken
import hashlib, hmac
from app.utils.crypto_utils import ble_mac
from app.utils.device_utils import SETUP_CLAIM_TTL
from app.routes.iot import init as iot_init
from app.routes.client import devices as client_devices

sent = []
iot_init.send_to_user = lambda user_uuid, title, body, data=None: sent.append((user_uuid, body))
client_devices.log_activity = lambda *a, **k: None

kek = Fernet(os.environ["MASTER_KEK"].encode())
BLE = dict(ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w", ble_manufacturer_uuid="m")
A, B, DEV = "u-a", "u-b", "dev-1"
KEY_A, KEY_B = os.urandom(16), os.urandom(16)
jti = str(uuid.uuid4())
SECRET = os.urandom(16).hex()
now = datetime.datetime.now(datetime.timezone.utc)

with _db.Session() as s:
    for uid, key in ((A, KEY_A), (B, KEY_B)):
        s.add(User(user_uuid=uid, user_name=uid, secret_key=kek.encrypt(key.hex().encode()).decode()))
    s.add(DeviceManagement(device_uuid=DEV, device_secret_key=kek.encrypt(SECRET.encode()).decode(),
                           device_token="t", setup_token="setup-tok", current_jti=jti, **BLE))
    s.add(UserDeviceMapping(user_uuid=A, device_uuid=DEV, display_name="a", role="master"))
    s.add(UserDeviceMapping(user_uuid=B, device_uuid=DEV, display_name="b", role="member"))
    s.add(UserToken(token_value="tok-b", user_uuid=B, device_uuid=DEV, expired_at=now + datetime.timedelta(hours=1)))
    s.add(UserToken(token_value="tok-b-old", user_uuid=B, device_uuid=DEV, expired_at=now - datetime.timedelta(hours=1)))
    s.commit()

app = Flask(__name__)
app.register_blueprint(iot_init.iot_bp)
app.register_blueprint(client_devices.client_bp)
c = app.test_client()

exp = now + datetime.timedelta(hours=1)
dev_hdr = {"Authorization": "Bearer " + jwt.encode(
    {"sub": DEV, "type": "device", "jti": jti, "exp": exp, **{"manufacturer_uuid": "m"}},
    os.environ["JWT_SECRET"], algorithm="HS256")}


def mac(key, nonce, token):
    # 서버 구현(ble_mac)과 독립적으로 계산해 형식을 교차 확인한다
    return hmac.new(key, (nonce + token).encode(), hashlib.sha256).hexdigest()


def validate(mac_hex, nonce, **extra):
    sent.clear()
    return c.post("/iot/validate_token", headers=dev_hdr,
                  json={"encrypted_token": mac_hex, "nonce": nonce, **extra})


NONCE = "0123456789abcdef"

# 앱(crypto-js HmacSHA256)과 공유하는 고정 벡터. 앱 쪽도 같은 값이 나와야 한다.
VECTOR = "ab30bf044923fcb75911a2375752c649ffcbdc4ca1aa251e391dcdc9fa3fdb8a"
assert ble_mac(bytes(range(16)), NONCE, "tok") == VECTOR
print("[ok] mac 형식이 고정 벡터와 일치한다")

# ── normal: user_uuid 없이 mac이 일치하는 사용자(B)가 식별된다 ──
r = validate(mac(KEY_B, NONCE, "tok-b"), NONCE)
assert r.status_code == 200, r.data
assert any(u == B for u, _ in sent), sent
print("[ok] user_uuid 없이 기기 매핑 사용자 키로 요청자를 찾는다")

# 과거 mac을 새 nonce와 함께 재전송하면 거부(nonce 바꿔치기 불가)
r = validate(mac(KEY_B, NONCE, "tok-b"), "fedcba9876543210")
assert r.status_code == 400, r.data
print("[ok] nonce 불일치(재전송)는 거부된다")

# 매핑되지 않은 사용자의 키로 만든 mac은 거부
r = validate(mac(os.urandom(16), NONCE, "tok-b"), NONCE)
assert r.status_code == 400, r.data
print("[ok] 어떤 매핑 사용자의 키로도 일치하지 않으면 거부된다")

# 본문에 user_uuid를 넣어도 무시된다(다른 사용자를 사칭할 수 없다)
r = validate(mac(KEY_B, NONCE, "tok-b"), NONCE, user_uuid=A)
assert r.status_code == 200, r.data
print("[ok] 본문의 user_uuid는 신뢰하지 않는다")

# 만료된 토큰도 사용자를 특정해 거부 사유를 본인에게 알린다
r = validate(mac(KEY_B, NONCE, "tok-b-old"), NONCE)
assert r.status_code == 400, r.data
assert (B, "인증 실패 — 사용할 수 없는 토큰입니다") in sent, sent
print("[ok] 만료 토큰은 거부되고 본인에게 사유가 통지된다")

# 토큰 없이 보낸 경우(mac = HMAC(key, nonce))도 사용자를 특정해 통지한다
r = validate(mac(KEY_A, NONCE, ""), NONCE)
assert r.status_code == 400, r.data
assert (A, "인증 실패 — 발급받은 토큰이 없습니다") in sent, sent
print("[ok] 토큰 미보유는 거부되고 본인에게 사유가 통지된다")

# 이전 6자리 nonce·형식이 다른 mac은 형식 오류
assert validate(mac(KEY_B, "abc123", "tok-b"), "abc123").status_code == 400
assert validate("ab" * 40, NONCE).status_code == 400
print("[ok] nonce 16자·mac 64자 hex가 아니면 거부된다")

# ── setup: master는 setup-token을 요청한 사용자다 ──
def as_user(uid):
    client_devices.verify_access_token = lambda h: ({"sub": uid}, None)


def setup_token(uid):
    as_user(uid)
    return c.post("/client/setup-token", headers={"Authorization": "Bearer x"}, json={"device_uuid": DEV})


# 등록된 기기는 마스터 본인만 받는다(추방된 멤버가 점유·토큰 획득을 못 하게)
assert setup_token(B).status_code == 403
assert setup_token(A).status_code == 200
print("[ok] 등록된 기기는 마스터가 아니면 setup-token을 받지 못한다")

# 이후는 미등록 기기(리셋 후) 기준
with _db.Session() as s:
    s.query(UserDeviceMapping).filter_by(device_uuid=DEV).delete()
    s.query(DeviceManagement).filter_by(device_uuid=DEV).update({"setup_user_uuid": None, "setup_requested_at": None})
    s.commit()

r = setup_token(A)
assert r.status_code == 200
tok_a = r.get_json()["data"]["setup_token"]
assert tok_a != "setup-tok"
print("[ok] 새 점유자에게는 setup_token을 새로 발급한다(리셋 전에 받아간 토큰은 무효)")
assert setup_token(B).status_code == 409
print("[ok] 다른 사용자가 점유 중이면 setup-token 발급을 거부한다")
r = setup_token(A)
assert r.status_code == 200 and r.get_json()["data"]["setup_token"] == tok_a
print("[ok] 같은 사용자는 다시 받을 수 있고 토큰도 그대로다")

# 점유 만료 후에는 다른 사용자가 가져갈 수 있다
with _db.Session() as s:
    d = s.query(DeviceManagement).filter_by(device_uuid=DEV).one()
    d.setup_requested_at = datetime.datetime.utcnow() - SETUP_CLAIM_TTL - datetime.timedelta(seconds=1)
    s.commit()
r = setup_token(B)
assert r.status_code == 200
tok_b = r.get_json()["data"]["setup_token"]
assert tok_b != tok_a
print("[ok] 점유가 만료되면 다른 사용자가 이어받고 토큰이 바뀐다")

# A가 기기에 넘긴 토큰으로 셋업이 끝나도 B가 master가 되지 않는다(만료 점유 가로채기 차단)
r = c.post("/iot/validate_setup", headers=dev_hdr, json={"setup_token": tok_a, "secret_key": SECRET})
assert r.status_code == 400, r.data
print("[ok] 이전 점유자의 토큰으로는 셋업이 완료되지 않는다")

# validate_setup: 본문에 user_uuid를 보내도 setup-token 요청자(B)가 master가 된다
r = c.post("/iot/validate_setup", headers=dev_hdr,
           json={"setup_token": tok_b, "secret_key": SECRET, "user_uuid": A})
assert r.status_code == 200, r.data
with _db.Session() as s:
    masters = [m.user_uuid for m in s.query(UserDeviceMapping).filter_by(device_uuid=DEV, role="master")]
    dev = s.query(DeviceManagement).filter_by(device_uuid=DEV).one()
    assert masters == [B], masters
    assert dev.setup_user_uuid is None and dev.setup_requested_at is None
print("[ok] master는 앱이 보낸 값이 아니라 서버가 기록한 요청자다")

# 설정 완료 후에는 요청자 정보가 비어 있어 재사용할 수 없다
with _db.Session() as s:
    d = s.query(DeviceManagement).filter_by(device_uuid=DEV).one()
    new_setup, new_jti = d.setup_token, d.current_jti
hdr2 = {"Authorization": "Bearer " + jwt.encode({"sub": DEV, "type": "device", "jti": new_jti, "exp": exp},
                                               os.environ["JWT_SECRET"], algorithm="HS256")}
r = c.post("/iot/validate_setup", headers=hdr2, json={"setup_token": new_setup, "secret_key": SECRET})
assert r.status_code == 400, r.data
print("[ok] 요청자 없이는 validate_setup이 거부된다")

# ── 리셋 증명: 초기화 때 서버에 알리지 못한 기기(서버에는 B가 master로 남음) ──
def reset_proof(svc_uuid, secret=SECRET):
    return hmac.new(bytes.fromhex(secret), f"reset|{svc_uuid}".encode(), hashlib.sha256).hexdigest()


def setup_token_with_proof(uid, proof):
    as_user(uid)
    return c.post("/client/setup-token", headers={"Authorization": "Bearer x"},
                  json={"device_uuid": DEV, "reset_proof": proof})


with _db.Session() as s:
    new_svc = s.query(DeviceManagement).filter_by(device_uuid=DEV).one().ble_service_uuid
assert new_svc != BLE["ble_service_uuid"]

assert setup_token_with_proof(A, reset_proof(BLE["ble_service_uuid"])).status_code == 403
print("[ok] 지난 셋업의 서비스 UUID로 만든 증명은 거부된다")
assert setup_token_with_proof(A, reset_proof(new_svc, os.urandom(16).hex())).status_code == 403
print("[ok] 다른 키로 만든 증명은 거부된다")

sent.clear()
r = setup_token_with_proof(A, reset_proof(new_svc))
assert r.status_code == 200, r.data
with _db.Session() as s:
    assert s.query(UserDeviceMapping).filter_by(device_uuid=DEV).count() == 0
    d = s.query(DeviceManagement).filter_by(device_uuid=DEV).one()
    assert d.setup_user_uuid == A and d.ble_service_uuid == new_svc
assert any(u == B for u, _ in sent), sent
print("[ok] 맞는 증명이면 리셋이 반영되어 새 사용자가 점유하고 이전 master에게 알린다")

assert setup_token_with_proof(B, reset_proof(new_svc)).status_code == 409
print("[ok] 리셋 뒤 같은 증명을 다시 써도 새 점유를 빼앗지 못한다")

print("\n전체 통과")
