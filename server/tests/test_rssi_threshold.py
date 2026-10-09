"""근접 해제 기기 임계값 API 테스트. 임시 DB만 사용, 네트워크 없음."""
import os, sys, tempfile, pathlib
from dotenv import load_dotenv

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()

os.environ["JWT_SECRET"] = "test-secret"
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

pushed = []
client_devices.send_to_device_role = lambda device_uuid, role, title, body, data=None: pushed.append((role, data))
client_devices.log_activity = lambda *a, **k: None

A, B, DEV = "u-a", "u-b", "dev-1"
with _db.Session() as s:
    for uid in (A, B):
        s.add(User(user_uuid=uid, user_name=uid, secret_key="k-" + uid))
    s.add(DeviceManagement(device_uuid=DEV, device_secret_key="sk", device_token="t",
                           ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w"))
    s.add(UserDeviceMapping(user_uuid=A, device_uuid=DEV, display_name="a", role="master"))
    s.add(UserDeviceMapping(user_uuid=B, device_uuid=DEV, display_name="b", role="member"))
    s.commit()

app = Flask(__name__)
app.register_blueprint(client_devices.client_bp)
c = app.test_client()
HDR = {"Authorization": "Bearer x"}


def as_user(uid):
    client_devices.verify_access_token = lambda h: ({"sub": uid}, None)


def post(uid, body):
    as_user(uid)
    return c.post("/client/device-rssi-threshold", headers=HDR, json=body)


def stored():
    with _db.Session() as s:
        return s.query(DeviceManagement).filter_by(device_uuid=DEV).one().rssi_threshold


# 기본값은 NULL (앱은 첫 발견 즉시 연결)
assert stored() is None
as_user(B)
r = c.get("/client/devices", headers=HDR)
assert r.status_code == 200 and r.json["data"][0]["rssi_threshold"] is None, r.data
print("[ok] 기본 임계값은 null로 내려간다")

assert post(A, {"device_uuid": DEV, "rssi_threshold": -65}).status_code == 200
assert stored() == -65
assert pushed and pushed[-1] == (["master", "member"], {"type": "refresh_devices"}), pushed
print("[ok] master가 설정하면 저장되고 마스터·멤버에게 갱신 푸시")

assert post(B, {"device_uuid": DEV, "rssi_threshold": -50}).status_code == 403
assert stored() == -65
print("[ok] member는 변경할 수 없다")

for bad in (-101, -19, "-60", -60.5, True, "x"):
    assert post(A, {"device_uuid": DEV, "rssi_threshold": bad}).status_code == 400, bad
assert stored() == -65
print("[ok] 범위 밖·정수 아님·bool은 거부")

assert post(A, {"device_uuid": DEV, "rssi_threshold": None}).status_code == 200
assert stored() is None
print("[ok] null로 해제할 수 있다")

as_user(A)
r = c.get("/client/devices", headers=HDR)
assert r.json["data"][0]["rssi_threshold"] is None

print("\n전체 통과")
