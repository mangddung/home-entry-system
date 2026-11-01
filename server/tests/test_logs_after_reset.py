"""활동 로그 조회: 기기 리셋 이전 로그는 다시 등록한 사용자에게 보이지 않는다. 임시 DB만 사용, 네트워크 없음."""
import os, sys, tempfile, pathlib
from datetime import datetime, timedelta, timezone
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
from app.utils.database.models import ActivityLog, DeviceManagement, UserDeviceMapping, User
from app.routes.client import logs as client_logs

OLD, NEW, DEV = "u-old", "u-new", "dev-1"
t0 = datetime.now(timezone.utc) - timedelta(hours=1)
with _db.Session() as s:
    for uid in (OLD, NEW):
        s.add(User(user_uuid=uid, user_name=uid, secret_key="k-" + uid))
    s.add(DeviceManagement(device_uuid=DEV, device_secret_key="sk", device_token="t",
                           ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w"))
    s.add(UserDeviceMapping(user_uuid=NEW, device_uuid=DEV, display_name="new", role="master"))
    s.add(ActivityLog(device_uuid=DEV, user_uuid=OLD, action="token_validated", created_at=t0))
    s.add(ActivityLog(device_uuid=DEV, action="device_reset", created_at=t0 + timedelta(minutes=1)))
    s.add(ActivityLog(device_uuid=DEV, user_uuid=NEW, action="token_validated", created_at=t0 + timedelta(minutes=2)))
    s.commit()

app = Flask(__name__)
app.register_blueprint(client_logs.logs_bp)
c = app.test_client()
client_logs.verify_access_token = lambda h: ({"sub": NEW}, None)

r = c.get(f"/client/logs?device_uuid={DEV}", headers={"Authorization": "Bearer x"})
assert r.status_code == 200, r.data
seen = [(l["action"], l["user_uuid"]) for l in r.json["data"]]
assert seen == [("token_validated", NEW)], seen
print("[ok] 마지막 리셋 이전 로그(이전 사용자 · 리셋 자체)는 보이지 않는다")
