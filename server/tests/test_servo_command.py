"""서보 범위 명령 서명 API 테스트. 임시 DB만 사용, 네트워크 없음."""
import hashlib, hmac, os, sys, tempfile, pathlib
from cryptography.fernet import Fernet
from dotenv import load_dotenv

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()

os.environ["JWT_SECRET"] = "test-secret"
os.environ["MASTER_KEK"] = Fernet.generate_key().decode()
for k in ("SETUP_SERVICE_UUID", "SETUP_WRITE_UUID", "SETUP_READ_UUID"):
    os.environ.setdefault(k, "x")

from app.utils.database import database as _db

tmpdir = pathlib.Path(tempfile.mkdtemp())
_db._DATA_DIR = tmpdir
_db._DB_PATH = tmpdir / "app.db"
_db.init_db()

from flask import Flask
from app.utils.database.models import DeviceManagement, UserDeviceMapping, User
from app.routes.client import devices as client_devices

logged = []
client_devices.log_activity = lambda action, **k: logged.append(action)

A, B, DEV = "u-a", "u-b", "dev-1"
RAW_KEY = bytes(range(16))
ENCRYPTED = Fernet(os.environ["MASTER_KEK"]).encrypt(RAW_KEY.hex().encode()).decode()
with _db.Session() as s:
    for uid in (A, B):
        s.add(User(user_uuid=uid, user_name=uid, secret_key="k-" + uid))
    s.add(DeviceManagement(device_uuid=DEV, device_secret_key=ENCRYPTED, device_token="t",
                           ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w"))
    s.add(UserDeviceMapping(user_uuid=A, device_uuid=DEV, display_name="a", role="master"))
    s.add(UserDeviceMapping(user_uuid=B, device_uuid=DEV, display_name="b", role="member"))
    s.commit()

app = Flask(__name__)
app.register_blueprint(client_devices.client_bp)
c = app.test_client()
HDR = {"Authorization": "Bearer x"}
NONCE = "0123456789abcdef"


def post(uid, **over):
    client_devices.verify_access_token = lambda h: ({"sub": uid}, None)
    body = {"device_uuid": DEV, "low_deg": 150, "high_deg": 20, "nonce": NONCE, **over}
    return c.post("/client/device-servo-command", headers=HDR, json=body)


r = post(A)
assert r.status_code == 200, r.data
expected = hmac.new(RAW_KEY, f"servo|{NONCE}|150|20".encode(), hashlib.sha256).hexdigest()
assert r.json["data"]["command"] == f"SRV:150:20:{expected}", r.json
assert logged == ["device_servo_range_requested"], logged
print("[ok] master는 기기 비밀키로 서명된 명령을 받는다")

assert post(B).status_code == 403
assert len(logged) == 1
print("[ok] member는 서명받을 수 없다")

client_devices.verify_access_token = lambda h: (None, "invalid")
assert c.post("/client/device-servo-command", headers=HDR, json={}).status_code == 401
print("[ok] 토큰이 없으면 거부")

for bad in ({"low_deg": 181}, {"high_deg": -1}, {"low_deg": "150"}, {"low_deg": 150.5}, {"low_deg": True},
            {"low_deg": 25}, {"nonce": "short"}, {"nonce": NONCE.upper()}, {"nonce": None}, {"device_uuid": ""}):
    assert post(A, **bad).status_code == 400, bad
print("[ok] 범위 밖·정수 아님·폭 10도 미만·잘못된 nonce는 거부")

print("\n전체 통과")
