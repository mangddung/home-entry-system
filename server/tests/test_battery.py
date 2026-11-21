"""기기 ping의 배터리 보고 테스트. 임시 DB만 사용, 네트워크 없음."""
import os, sys, tempfile, pathlib, datetime, uuid
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

import jwt
from flask import Flask
from app.utils.database.models import DeviceManagement, Gateway, UserDeviceMapping, User
from app.utils.device_utils import battery_percent
from app.routes.client import devices as client_devices
from app.routes.iot import init as iot
import mqtt_worker as w

USER, WIFI, ZB, IEEE, GW = "u-1", "dev-wifi", "dev-zb", "0xe8f60afffefc97e0", "gw-dev"
jti = str(uuid.uuid4())
SECRET_HEX = "00112233445566778899aabbccddeeff"
KEY = bytes.fromhex(SECRET_HEX)

with _db.Session() as s:
    s.add(User(user_uuid=USER, user_name="u", secret_key="x"))
    s.add(Gateway(gateway_id=GW))
    s.add(DeviceManagement(device_uuid=WIFI, device_secret_key="k", device_token="t", current_jti=jti,
                           ble_service_uuid="s1", ble_read_uuid="r1", ble_write_uuid="w1"))
    s.add(DeviceManagement(device_uuid=ZB, device_token="t2", transport="zigbee", ieee_addr=IEEE,
                           device_secret_key=Fernet(os.environ["MASTER_KEK"].encode()).encrypt(SECRET_HEX.encode()).decode(),
                           ble_service_uuid="s2", ble_read_uuid="r2", ble_write_uuid="w2"))
    s.add(UserDeviceMapping(user_uuid=USER, device_uuid=WIFI, display_name="u", role="master"))
    s.add(UserDeviceMapping(user_uuid=USER, device_uuid=ZB, display_name="u", role="master"))
    s.commit()


def stored(device_uuid):
    with _db.Session() as s:
        return s.query(DeviceManagement).filter_by(device_uuid=device_uuid).one().battery_mv


def listed_percent(device_uuid):
    rows = c.get("/client/devices", headers=HDR).json["data"]
    return next(d["battery_percent"] for d in rows if d["device_uuid"] == device_uuid)


# 잔량 변환
for mv, pct in ((None, None), (3000, 0), (3300, 0), (3600, 10), (3650, 18), (3800, 55), (4150, 100), (4200, 100)):
    assert battery_percent(mv) == pct, (mv, battery_percent(mv))
print("[ok] 전압을 곡선에 맞춰 잔량으로 바꾼다")

app = Flask(__name__)
app.register_blueprint(iot.iot_bp)
app.register_blueprint(client_devices.client_bp)
c = app.test_client()
device_token = jwt.encode(
    {"sub": WIFI, "type": "device", "jti": jti,
     "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)},
    os.environ["JWT_SECRET"], algorithm="HS256")
HDR = {"Authorization": f"Bearer {device_token}"}


def ping(**kwargs):
    r = c.post("/iot/ping", headers=HDR, **kwargs)
    assert r.status_code == 200, r.data
    return r


ping(json={"battery_mv": 3800})
assert stored(WIFI) == 3800
print("[ok] Wi-Fi ping의 전압을 저장한다")

client_devices.verify_access_token = lambda h: ({"sub": USER}, None)
assert listed_percent(WIFI) is None
print("[ok] Wi-Fi 모델은 전압이 있어도 잔량을 내려주지 않는다")

for bad in (2499, 4501, "3800", 3800.5, True, None):
    ping(json={"battery_mv": 3800})
    ping(json={"battery_mv": bad})
    assert stored(WIFI) is None, bad
print("[ok] 범위 밖·정수 아닌 값은 NULL로 지운다")

ping(json={"battery_mv": 3800})
ping(json={})
assert stored(WIFI) is None
print("[ok] 전압을 안 보내면(셀 없음) 지운다")

ping(json={"battery_mv": 3800})
ping(data="not json", content_type="application/json")
assert stored(WIFI) is None
ping(json=[3800])
assert stored(WIFI) is None
print("[ok] 본문이 객체가 아니어도 ping은 성공한다")


def zb_ping(seq, body):
    req = bytes([w.PING, seq]) + body
    rsp = w.handle(GW, IEEE, req + w.tag(KEY, req))
    assert rsp is not None and rsp[0] == w.PING_RESULT, rsp


zb_ping(1, b"\x00rand" + (3800).to_bytes(2, "little"))
assert stored(ZB) == 3800
assert listed_percent(ZB) == 55
print("[ok] Zigbee ping의 전압을 저장하고 목록에 잔량이 내려간다")

zb_ping(2, b"\x00rand" + (0).to_bytes(2, "little"))
assert stored(ZB) is None
assert listed_percent(ZB) is None
print("[ok] Zigbee 전압 0은 셀 없음으로 지우고 목록도 null이다")

zb_ping(3, b"\x00rand" + (3900).to_bytes(2, "little"))
zb_ping(4, b"\x00rand")
assert stored(ZB) is None
print("[ok] 전압을 안 싣는 옛 펌웨어 ping도 처리한다")

print("\n전체 통과")
