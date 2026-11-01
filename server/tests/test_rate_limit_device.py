"""문 열기 요청 제한은 기기별로 센다. 프록시 뒤에서 IP가 같아도 한 기기가 다른 기기를 막지 않는다. 임시 DB만 사용, 네트워크 없음."""
import os, sys, tempfile, pathlib, datetime
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

import jwt
from flask import Flask
from app.utils.limiter import limiter
from app.routes.iot import init as iot_init

app = Flask(__name__)
limiter.init_app(app)
app.register_blueprint(iot_init.iot_bp)
c = app.test_client()

exp = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)


def post(device, secret="test-secret"):
    token = jwt.encode({"sub": device, "type": "device", "jti": "j", "exp": exp}, secret, algorithm="HS256")
    return c.post("/iot/validate_token", headers={"Authorization": "Bearer " + token}).status_code


for _ in range(20):
    assert post("dev-a") != 429
assert post("dev-a") == 429
print("[ok] 한 기기는 분당 20회로 제한된다")

assert post("dev-b") != 429
print("[ok] 다른 기기는 같은 IP여도 막히지 않는다")

for _ in range(20):
    assert post("dev-c", secret="forged") != 429
assert post("dev-c", secret="forged") == 429
assert post("dev-c") != 429
print("[ok] 위조 토큰은 IP로 세므로 그 기기의 제한을 소모하지 못한다")

print("\n전체 통과")
