"""마스터·멤버 출입 토큰을 서버와 통신될 때 가득 채우는지 테스트. 임시 DB만 사용, 네트워크 없음."""
import os, sys, tempfile, pathlib
from datetime import datetime
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

from app.utils.database.models import UserToken
from app.routes.client.devices import _get_or_create_token

USER, DEV = "u-1", "dev-1"


def issue(role="member"):
    with _db.Session() as s:
        t = _get_or_create_token(s, USER, DEV, role)
        s.commit()
        return t


def use(token_value, times=1):
    with _db.Session() as s:
        s.query(UserToken).filter_by(token_value=token_value).one().use_count += times
        s.commit()


def live_tokens():
    with _db.Session() as s:
        return s.query(UserToken).filter_by(user_uuid=USER, device_uuid=DEV, is_revoked=False).count()


# 쓰지 않은 토큰은 그대로 돌려준다
t1 = issue()
assert t1["max_uses"] == 5 and t1["use_count"] == 0
assert issue()["token_value"] == t1["token_value"]
print("[ok] 안 쓴 토큰은 유지")

# 한 번이라도 쓰면 다음 조회에서 새 5회 토큰으로 바뀌고 옛 토큰은 폐기된다
use(t1["token_value"])
t2 = issue()
assert t2["token_value"] != t1["token_value"] and t2["use_count"] == 0 and t2["max_uses"] == 5
assert live_tokens() == 1
print("[ok] 쓴 토큰은 통신될 때 새 5회 토큰으로 교체")

# 방금 만든 토큰의 만료 시각도 앱이 읽는 형식이어야 한다("+00:00Z"면 앱이 무효로 본다)
for t in (t1, t2):
    assert t["expired_at"].endswith("Z") and "+" not in t["expired_at"], t["expired_at"]
    datetime.fromisoformat(t["expired_at"][:-1])
print("[ok] 새로 만든 토큰의 만료 시각 형식이 정상")

# 마스터도 같다
use(t2["token_value"], 3)
t3 = issue("master")
assert t3["token_value"] != t2["token_value"] and t3["use_count"] == 0
print("[ok] 마스터도 교체")

# 게스트 토큰은 마스터가 정한 횟수라 바꾸지 않는다(쓴 상태 그대로 돌려준다)
use(t3["token_value"])
g = issue("guest")
assert g["token_value"] == t3["token_value"] and g["use_count"] == 1
print("[ok] 게스트 토큰은 유지")

print("전체 통과")
