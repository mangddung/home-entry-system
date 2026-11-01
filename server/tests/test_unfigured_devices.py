"""미설정 기기 조회 API 테스트: master 기기만 반환. 임시 DB만 사용, 네트워크 없음."""
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

M, G, DEV = "u-master", "u-guest", "dev-1"
with _db.Session() as s:
    for uid in (M, G):
        s.add(User(user_uuid=uid, user_name=uid, secret_key="k-" + uid))
    s.add(DeviceManagement(device_uuid=DEV, device_secret_key="sk", device_token="t",
                           ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w"))
    s.add(UserDeviceMapping(user_uuid=M, device_uuid=DEV, display_name="m", role="master"))
    s.add(UserDeviceMapping(user_uuid=G, device_uuid=DEV, display_name="g", role="guest"))
    s.commit()

app = Flask(__name__)
app.register_blueprint(client_devices.client_bp)
c = app.test_client()


def unfigured(uid):
    client_devices.verify_access_token = lambda h: ({"sub": uid}, None)
    r = c.get("/client/unfigured-devices", headers={"Authorization": "Bearer x"})
    assert r.status_code == 200, r.data
    return {(d["device_uuid"], d["type"]) for d in r.json["data"]}


assert unfigured(M) == {(DEV, "location"), (DEV, "setting")}
print("[ok] master에게는 위치·설정 미등록 기기가 내려간다")

assert unfigured(G) == set()
print("[ok] master가 아니면 미설정 기기를 받지 않는다")
