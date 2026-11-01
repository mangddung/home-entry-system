"""카카오 로그인: 토큰은 URL에 실리지 않고 일회용 코드 + verifier로만 교환된다. 임시 DB만 사용, 네트워크 없음(카카오 호출은 가짜)."""
import os, sys, tempfile, pathlib, datetime, hashlib
from urllib.parse import urlparse, parse_qs
from dotenv import load_dotenv

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()

os.environ["JWT_SECRET"] = "test-secret"
os.environ["KAKAO_CLIENT_ID"] = "cid"
os.environ["KAKAO_REDIRECT_URI"] = "http://x/cb"

from app.utils.database import database as _db

tmpdir = pathlib.Path(tempfile.mkdtemp())
_db._DATA_DIR = tmpdir
_db._DB_PATH = tmpdir / "app.db"
_db.init_db()

import jwt
from flask import Flask
from app.utils.database.models import OAuthLoginCode, User
from app.routes.client import oauth


class FakeResponse:
    ok = True

    def __init__(self, body):
        self.body = body

    def json(self):
        return self.body


oauth.requests.post = lambda *a, **k: FakeResponse({"access_token": "kakao-at", "expires_in": 3600})
oauth.requests.get = lambda *a, **k: FakeResponse({"id": 42, "properties": {"nickname": "tester"}})

app = Flask(__name__)
app.register_blueprint(oauth.kakao_bp)
c = app.test_client()

VERIFIER = "v" * 64
STATE = hashlib.sha256(VERIFIER.encode()).hexdigest()


def login():
    r = c.get(f"/auth/kakao/callback?code=abc&state={STATE}")
    assert r.status_code == 302, r.data
    assert r.location.startswith("iotapp://login_oauth?")
    assert "access_token" not in r.location and "refresh_token" not in r.location
    q = parse_qs(urlparse(r.location).query)
    assert q["state"] == [STATE]
    return q["code"][0]


def exchange(code, verifier=VERIFIER):
    return c.post("/auth/kakao/exchange", json={"code": code, "verifier": verifier})


assert "error=state_invalid" in c.get("/auth/kakao/callback?code=abc").location
assert "error=state_invalid" in c.get("/auth/kakao/callback?code=abc&state=short").location
print("[ok] state 없는 콜백은 거부된다")

code = login()
print("[ok] 리다이렉트 URL에 토큰이 없다")

r = exchange(code, verifier="wrong")
assert r.status_code == 400
assert exchange(code).status_code == 400
print("[ok] verifier가 틀리면 거부되고 코드는 그 자리에서 폐기된다")

code = login()
r = exchange(code)
assert r.status_code == 200, r.data
payload = jwt.decode(r.json["access_token"], "test-secret", algorithms=["HS256"])
assert payload["sub"] == r.json["user_uuid"] and r.json["refresh_token"]
print("[ok] 올바른 verifier면 토큰을 받는다")

assert exchange(code).status_code == 400
print("[ok] 코드는 한 번만 쓸 수 있다")

code = login()
with _db.Session() as s:
    row = s.get(OAuthLoginCode, code)
    row.expired_at = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=1)
    s.commit()
assert exchange(code).status_code == 400
print("[ok] 만료된 코드는 거부된다")

assert c.post("/auth/kakao/exchange", json={"code": 1, "verifier": None}).status_code == 400
print("[ok] 형식이 틀린 요청은 거부된다")

oauth.requests.get = lambda *a, **k: FakeResponse({"id": 43, "properties": {"nickname": "tester"}})
r = exchange(login())
assert r.status_code == 200, r.data
with _db.Session() as s:
    names = sorted(u.user_name for u in s.query(User))
assert names == ["tester", "tester_43"], names
print("[ok] 닉네임이 같은 다른 카카오 사용자도 가입할 수 있다")

print("\n전체 통과")
