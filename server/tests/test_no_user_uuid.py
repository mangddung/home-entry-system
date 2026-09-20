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
from app.utils.crypto_utils import encrypt_data
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
    s.commit()

app = Flask(__name__)
app.register_blueprint(iot_init.iot_bp)
app.register_blueprint(client_devices.client_bp)
c = app.test_client()

exp = now + datetime.timedelta(hours=1)
dev_hdr = {"Authorization": "Bearer " + jwt.encode(
    {"sub": DEV, "type": "device", "jti": jti, "exp": exp, **{"manufacturer_uuid": "m"}},
    os.environ["JWT_SECRET"], algorithm="HS256")}


def cipher(key, nonce, token):
    return encrypt_data({"nonce": nonce, "timestamp": "t", "auth_token": token}, key)


# ── normal: user_uuid 없이 복호화 성공한 사용자(B)가 식별된다 ──
r = c.post("/iot/validate_token", headers=dev_hdr,
           json={"encrypted_token": cipher(KEY_B, "abc123", "tok-b"), "nonce": "abc123"})
assert r.status_code == 200, r.data
assert any(u == B for u, _ in sent), sent
print("[ok] user_uuid 없이 기기 매핑 사용자 키로 요청자를 찾는다")

# nonce가 다르면 거부
r = c.post("/iot/validate_token", headers=dev_hdr,
           json={"encrypted_token": cipher(KEY_B, "abc123", "tok-b"), "nonce": "ffffff"})
assert r.status_code == 400, r.data
print("[ok] nonce 불일치는 거부된다")

# 매핑되지 않은 사용자의 키로 만든 암호문은 거부
r = c.post("/iot/validate_token", headers=dev_hdr,
           json={"encrypted_token": cipher(os.urandom(16), "abc123", "tok-b"), "nonce": "abc123"})
assert r.status_code == 400, r.data
print("[ok] 어떤 매핑 사용자의 키로도 안 풀리면 거부된다")

# 본문에 user_uuid를 넣어도 무시된다(다른 사용자를 사칭할 수 없다)
r = c.post("/iot/validate_token", headers=dev_hdr,
           json={"user_uuid": A, "encrypted_token": cipher(KEY_B, "abc123", "tok-b"), "nonce": "abc123"})
assert r.status_code == 200, r.data
print("[ok] 본문의 user_uuid는 신뢰하지 않는다")

# ── setup: master는 setup-token을 요청한 사용자다 ──
def as_user(uid):
    client_devices.verify_access_token = lambda h: ({"sub": uid}, None)


def setup_token(uid):
    as_user(uid)
    return c.post("/client/setup-token", headers={"Authorization": "Bearer x"}, json={"device_uuid": DEV})


assert setup_token(A).status_code == 200
assert setup_token(B).status_code == 409
print("[ok] 다른 사용자가 점유 중이면 setup-token 발급을 거부한다")
assert setup_token(A).status_code == 200
print("[ok] 같은 사용자는 다시 받을 수 있다")

# 점유 만료 후에는 다른 사용자가 가져갈 수 있다
with _db.Session() as s:
    d = s.query(DeviceManagement).filter_by(device_uuid=DEV).one()
    d.setup_requested_at = datetime.datetime.utcnow() - SETUP_CLAIM_TTL - datetime.timedelta(seconds=1)
    s.commit()
assert setup_token(B).status_code == 200
print("[ok] 점유가 만료되면 다른 사용자가 이어받는다")

# validate_setup: 본문에 user_uuid를 보내도 setup-token 요청자(B)가 master가 된다
r = c.post("/iot/validate_setup", headers=dev_hdr,
           json={"setup_token": "setup-tok", "secret_key": SECRET, "user_uuid": A})
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

print("\n전체 통과")
