"""기기 요청이 들어오면 last_ping_at이 갱신되는지 확인. 임시 DB만 사용, 네트워크 없음."""
import os, sys, tempfile, pathlib, datetime, uuid
from dotenv import load_dotenv

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()
for k, v in (("JWT_SECRET", "test-secret"), ("MASTER_KEK", "")):
    os.environ.setdefault(k, v)

from app.utils.database import database as _db

tmpdir = pathlib.Path(tempfile.mkdtemp())
_db._DATA_DIR = tmpdir
_db._DB_PATH = tmpdir / "app.db"
_db.init_db()

import jwt
from flask import Flask
from app.utils.database.models import DeviceManagement, UserDeviceMapping, User
from app.routes.iot import init as iot_init

pushed = []
iot_init.send_to_device_master = lambda device_uuid, title, body, data=None: pushed.append((title, body, data))

MASTER, DEV = "u-master", "dev-ping"
jti = str(uuid.uuid4())
BLE = dict(ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w", ble_manufacturer_uuid="m")

with _db.Session() as s:
    s.add(User(user_uuid=MASTER, user_name="master", secret_key="x"))
    s.add(DeviceManagement(device_uuid=DEV, device_secret_key="k", device_token="t",
                           current_jti=jti, last_ping_at=None, **BLE))
    s.add(UserDeviceMapping(user_uuid=MASTER, device_uuid=DEV, display_name="주인",
                            role="master", device_nickname="현관문"))
    s.commit()


def last_ping():
    with _db.Session() as s:
        return s.query(DeviceManagement).filter_by(device_uuid=DEV).one().last_ping_at


assert last_ping() is None

device_token = jwt.encode(
    {"sub": DEV, "type": "device", "jti": jti,
     "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1),
     "ble_service_uuid": "s", "ble_read_uuid": "r", "ble_write_uuid": "w", "manufacturer_uuid": "m"},
    os.environ["JWT_SECRET"], algorithm="HS256")

# 토큰 검증만으로 갱신된다 = 모든 기기 API가 생존 신호가 된다
assert iot_init._decode_device_token(device_token) is not None
first = last_ping()
assert first is not None
print("[ok] 기기 토큰 검증 시 last_ping_at이 기록된다")

app = Flask(__name__)
app.register_blueprint(iot_init.iot_bp)
c = app.test_client()

with _db.Session() as s:
    s.query(DeviceManagement).filter_by(device_uuid=DEV).one().last_ping_at = None
    s.commit()

r = c.post("/iot/init", json={}, headers={"Authorization": f"Bearer {device_token}"})
assert r.status_code == 200, r.data
assert last_ping() is not None
print("[ok] /iot/init(전원 켜짐)이 온라인 상태를 만든다")
assert pushed and pushed[0][2] == {"type": "refresh_devices"}, pushed
print("[ok] 전원 켜짐 푸시가 기기 목록 갱신 신호를 싣는다")

with _db.Session() as s:
    s.query(DeviceManagement).filter_by(device_uuid=DEV).one().last_ping_at = None
    s.commit()

r = c.post("/iot/ping", json={}, headers={"Authorization": f"Bearer {device_token}"})
assert r.status_code == 200, r.data
assert last_ping() is not None
assert r.get_json()["registered"] is True, r.data
print("[ok] /iot/ping도 그대로 동작한다")

# 마스터 매핑이 없으면(앱에서 삭제) registered=false로 기기에 초기화를 알린다
with _db.Session() as s:
    s.query(UserDeviceMapping).filter_by(device_uuid=DEV).delete()
    s.commit()
r = c.post("/iot/ping", json={}, headers={"Authorization": f"Bearer {device_token}"})
assert r.status_code == 200, r.data
assert r.get_json()["registered"] is False, r.data
print("[ok] 삭제된 기기는 ping 응답에 registered=false를 받는다")

# 잘못된 토큰은 갱신하지 않는다
with _db.Session() as s:
    s.query(DeviceManagement).filter_by(device_uuid=DEV).one().last_ping_at = None
    s.commit()
bad = jwt.encode({"sub": DEV, "type": "device", "jti": "other-jti",
                  "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)},
                 os.environ["JWT_SECRET"], algorithm="HS256")
r = c.post("/iot/ping", json={}, headers={"Authorization": f"Bearer {bad}"})
assert r.status_code == 401, r.data
assert last_ping() is None
print("[ok] 폐기된 토큰은 생존 신호로 치지 않는다")

print("\n전체 통과")
