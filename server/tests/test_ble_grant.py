"""BLE 연결 권한(서보 실시간 조절·재본딩) 서명 API 테스트. 임시 DB만 사용, 네트워크 없음."""
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

logged, pushed = [], []
client_devices.log_activity = lambda action, **k: logged.append(action)
client_devices.send_to_device_role = lambda device_uuid, role, title, body, data=None: pushed.append((role, title))

A, B, DEV = "u-a", "u-b", "dev-1"
RAW_KEY = bytes(range(16))
ENCRYPTED = Fernet(os.environ["MASTER_KEK"]).encrypt(RAW_KEY.hex().encode()).decode()
with _db.Session() as s:
    for uid in (A, B):
        s.add(User(user_uuid=uid, user_name=uid, secret_key="k-" + uid))
    s.add(DeviceManagement(device_uuid=DEV, device_secret_key=ENCRYPTED, device_token="t",
                           ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w"))
    s.add(UserDeviceMapping(user_uuid=A, device_uuid=DEV, display_name="a", role="master", device_nickname="현관문"))
    s.add(UserDeviceMapping(user_uuid=B, device_uuid=DEV, display_name="b", role="member"))
    s.commit()

app = Flask(__name__)
app.register_blueprint(client_devices.client_bp)
c = app.test_client()
HDR = {"Authorization": "Bearer x"}
NONCE = "0123456789abcdef"


def post(uid, **over):
    client_devices.verify_access_token = lambda h: ({"sub": uid}, None)
    body = {"device_uuid": DEV, "nonce": NONCE, "purpose": "live", **over}
    return c.post("/client/device-ble-grant", headers=HDR, json=body)


def expected(domain):
    return hmac.new(RAW_KEY, f"{domain}|{NONCE}".encode(), hashlib.sha256).hexdigest()


r = post(A)
assert r.status_code == 200, r.data
assert r.json["data"]["command"] == f"SRVS:{expected('ble-live')}", r.json
assert logged == ["device_ble_live_started"] and not pushed, (logged, pushed)
print("[ok] master는 조절 허가를 받고, 조절 시작은 로그만 남는다")

r = post(A, purpose="bond")
assert r.status_code == 200, r.data
assert r.json["data"]["command"] == f"SRVB:{expected('ble-bond')}", r.json
assert logged[-1] == "device_ble_rebond_requested", logged
assert pushed == [("master", "현관문 기기 알림")], pushed
print("[ok] 재본딩 허가는 로그와 마스터 푸시를 남긴다")

assert expected("ble-live") != expected("ble-bond")
print("[ok] 조절 허가로 재본딩할 수 없도록 서명 문자열을 나눈다")

del logged[:], pushed[:]
assert post(B).status_code == 403
assert post(B, purpose="bond").status_code == 403
assert not logged and not pushed
print("[ok] member는 어느 허가도 받을 수 없고 기록도 남지 않는다")

client_devices.verify_access_token = lambda h: (None, "invalid")
assert c.post("/client/device-ble-grant", headers=HDR, json={}).status_code == 401
print("[ok] 토큰이 없으면 거부")

for bad in ({"purpose": "servo"}, {"purpose": None}, {"purpose": ["live"]}, {"nonce": "short"},
            {"nonce": NONCE.upper()}, {"nonce": None}, {"device_uuid": ""}):
    assert post(A, **bad).status_code == 400, bad
print("[ok] 잘못된 용도·nonce는 거부")

assert post(A, device_uuid="no-such-device").status_code == 403
print("[ok] 없는 기기는 master가 아니므로 거부")

print("\n전체 통과")
