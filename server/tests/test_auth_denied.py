"""인증 거부 시 사용자 알림·기록 스모크 테스트. 임시 DB만 사용, 네트워크 없음."""
import os, sys, json, tempfile, pathlib, datetime, uuid
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
from app.utils.database.models import User, DeviceManagement, UserDeviceMapping, ActivityLog
from app.routes.client.logs import logs_bp, ACCESS_ACTIONS
from app.routes.iot import init as iot_init

sent = []
iot_init.send_to_user = lambda user_uuid, title, body, data=None: sent.append((user_uuid, title, body))

GUEST, DEV = "u-guest", "dev-0001"
jti = str(uuid.uuid4())
with _db.Session() as s:
    s.add(User(user_uuid=GUEST, user_name="guest", secret_key="x", current_jti=jti))
    s.add(DeviceManagement(device_uuid=DEV, device_secret_key="k", device_token="t",
                           ble_service_uuid="s", ble_write_uuid="w", ble_read_uuid="r",
                           ble_manufacturer_uuid="m"))
    s.add(UserDeviceMapping(user_uuid=GUEST, device_uuid=DEV, display_name="게스트",
                            role="guest", device_nickname="우리집 도어락"))
    s.commit()

with _db.Session() as s:
    iot_init._notify_auth_denied(s, GUEST, DEV, "사용 가능한 시간이 아닙니다")

assert len(sent) == 1, sent
user_uuid, title, body = sent[0]
assert user_uuid == GUEST
assert title == "우리집 도어락 기기 알림"
assert "사용 가능한 시간이 아닙니다" in body
print("[ok] 거부 사유가 본인에게 푸시된다")

with _db.Session() as s:
    log = s.query(ActivityLog).filter_by(action="token_denied").one()
    detail = json.loads(log.detail)
assert log.user_uuid == GUEST and log.device_uuid == DEV
assert detail["display_name"] == "게스트"
assert detail["reason"] == "사용 가능한 시간이 아닙니다"
print("[ok] 거부가 활동 기록에 남는다")

# 멤버(비마스터)도 본인 거부 기록을 출입 탭에서 본다
assert "token_denied" in ACCESS_ACTIONS
app = Flask(__name__)
app.register_blueprint(logs_bp)
c = app.test_client()
token = jwt.encode({"sub": GUEST, "jti": jti,
                    "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)},
                   os.environ["JWT_SECRET"], algorithm="HS256")
r = c.get(f"/client/logs?device_uuid={DEV}&category=access",
          headers={"Authorization": f"Bearer {token}"})
assert r.status_code == 200, r.data
actions = [row["action"] for row in r.get_json()["data"]]
assert actions == ["token_denied"], actions
print("[ok] 출입 기록 조회에 거부가 포함된다")

print("\n전체 통과")
