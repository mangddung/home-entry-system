"""활동 로그 페이지네이션. 임시 DB만 사용, 네트워크 없음."""
import os, sys, tempfile, pathlib
from dotenv import load_dotenv

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()

os.environ["JWT_SECRET"] = "test-secret"

from app.utils.database import database as _db

tmpdir = pathlib.Path(tempfile.mkdtemp())
_db._DATA_DIR = tmpdir
_db._DB_PATH = tmpdir / "app.db"
_db.init_db()

from flask import Flask
from app.utils.database.models import ActivityLog, DeviceManagement, User, UserDeviceMapping
from app.routes.client import logs as client_logs

U, D = "u-1", "dev-1"
with _db.Session() as s:
    s.add(User(user_uuid=U, user_name=U, secret_key="k"))
    s.add(DeviceManagement(device_uuid=D, device_secret_key="sk", device_token="t",
                           ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w"))
    s.add(UserDeviceMapping(user_uuid=U, device_uuid=D, display_name="m", role="master"))
    s.flush()
    s.add_all([ActivityLog(device_uuid=D, action=f"device_{i}") for i in range(5)])
    s.commit()

app = Flask(__name__)
app.register_blueprint(client_logs.logs_bp)
c = app.test_client()
client_logs.verify_access_token = lambda h: ({"sub": U}, None)


def get(query):
    r = c.get(f"/client/logs?device_uuid={D}{query}", headers={"Authorization": "Bearer x"})
    assert r.status_code == 200, r.data
    return r.json


page = get("&limit=2")
assert [l["action"] for l in page["data"]] == ["device_4", "device_3"]
assert page["next_before_id"] == page["data"][-1]["id"]
print("[ok] 최신순으로 limit만큼 주고 다음 커서를 함께 준다")

page = get(f"&limit=2&before_id={page['next_before_id']}")
assert [l["action"] for l in page["data"]] == ["device_2", "device_1"]
page = get(f"&limit=2&before_id={page['next_before_id']}")
assert [l["action"] for l in page["data"]] == ["device_0"]
assert page["next_before_id"] is None
print("[ok] 커서로 끝까지 이어지고 마지막 페이지의 커서는 null이다")

assert len(get("")["data"]) == 5
assert len(get("&limit=0")["data"]) == 1
assert len(get("&limit=abc")["data"]) == 5
print("[ok] limit 기본값과 범위를 지킨다")

print("\n전체 통과")
