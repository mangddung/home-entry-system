"""기기 삭제 시 Zigbee 기기에만 '바로 ping 하라' 신호(CHECK_REG)를 보내는지 확인. 임시 DB만 사용, 브로커·네트워크 없음."""
import os, sys, tempfile, pathlib
from dotenv import load_dotenv

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()
os.environ.setdefault("JWT_SECRET", "test-secret")
for k in ("SETUP_SERVICE_UUID", "SETUP_WRITE_UUID", "SETUP_READ_UUID"):
    os.environ.setdefault(k, "x")

from app.utils.database import database as _db

tmpdir = pathlib.Path(tempfile.mkdtemp())
_db._DATA_DIR = tmpdir
_db._DB_PATH = tmpdir / "app.db"
_db.init_db()

from flask import Flask
from app.utils import mqtt_utils
from app.utils.database.models import DeviceManagement, UserDeviceMapping, User
from app.routes.client import devices as client_devices

notified = []
client_devices.notify_zigbee_check_registration = lambda gw, ieee: notified.append((gw, ieee))
client_devices.log_activity = lambda *a, **k: None
client_devices.send_to_user = lambda *a, **k: None
client_devices.verify_access_token = lambda h: ({"sub": "u-1"}, None)

GW, IEEE = "gw-dev", "0xe8f60afffefc97e0"
with _db.Session() as s:
    s.add(User(user_uuid="u-1", user_name="u", secret_key="k"))
    for uuid, transport, ieee, gw in (("dev-zb", "zigbee", IEEE, GW), ("dev-wifi", "wifi", None, None)):
        s.add(DeviceManagement(device_uuid=uuid, device_secret_key="k-" + uuid, device_token="t-" + uuid,
                               ble_service_uuid="s-" + uuid, ble_read_uuid="r-" + uuid, ble_write_uuid="w-" + uuid,
                               transport=transport, ieee_addr=ieee, gateway_id=gw))
        s.add(UserDeviceMapping(user_uuid="u-1", device_uuid=uuid, display_name="u", role="master"))
    s.commit()

app = Flask(__name__)
app.register_blueprint(client_devices.client_bp)
c = app.test_client()


def delete(uuid):
    return c.delete(f"/client/device?device_uuid={uuid}", headers={"Authorization": "Bearer x"})


assert delete("dev-zb").status_code == 200
assert notified == [(GW, IEEE)], notified
with _db.Session() as s:
    assert s.query(DeviceManagement).filter_by(device_uuid="dev-zb").one().gateway_id is None
print("[ok] Zigbee 기기 삭제 → 삭제 전 게이트웨이·IEEE로 신호, 새 행은 게이트웨이 묶음 해제")

notified.clear()
assert delete("dev-wifi").status_code == 200
assert notified == [], notified
print("[ok] Wi-Fi 기기 삭제는 신호 없음")

# 발행 형식: homes/<gw>/<ieee>/set {"doorlock_rsp": "8500"} — 펌웨어 ZB_MSG_CHECK_REG(0x85), seq 0, 데이터 없음
published = []
mqtt_utils.publish_json = lambda topic, payload: published.append((topic, payload))
mqtt_utils.threading.Thread = lambda target, args, daemon: type("T", (), {"start": lambda self: target(*args)})()
mqtt_utils.notify_zigbee_check_registration(GW, IEEE)
assert published == [(f"homes/{GW}/{IEEE}/set", {"doorlock_rsp": "8500"})], published
print("[ok] 신호 토픽·페이로드가 펌웨어·Z2M 컨버터 형식과 맞다")

print("\n전체 통과")
