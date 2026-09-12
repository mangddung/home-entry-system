"""초대 코드 미리보기/토큰 발급/탈퇴 흐름 스모크 테스트. 임시 DB만 사용."""
import os, sys, shutil, tempfile, pathlib, datetime
from dotenv import load_dotenv

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()
for k, v in (("SETUP_SERVICE_UUID", "s-uuid"), ("SETUP_WRITE_UUID", "w-uuid"),
             ("SETUP_READ_UUID", "r-uuid"), ("JWT_SECRET", "test-secret"),
             ("MASTER_KEK", "")):
    os.environ.setdefault(k, v)

from app.utils.database import database as _db

tmpdir = pathlib.Path(tempfile.mkdtemp())
_db._DATA_DIR = tmpdir
_db._DB_PATH = tmpdir / "app.db"

_db.init_db()
# 2회 호출해도 안전한지(idempotent) 확인
_db.init_db()

from sqlalchemy import inspect
cols = {c["name"] for c in inspect(_db.engine).get_columns("invite_codes")}
assert {"token_max_uses", "token_expire_minutes", "token_not_before"} <= cols, cols
print("[ok] 마이그레이션 컬럼 생성 + 재실행 안전")

import jwt, uuid, secrets
from flask import Flask
from app.utils.database.models import User, DeviceManagement, UserDeviceMapping, UserToken, InviteCode, TokenUsage
from app.routes.client.auth import auth_bp
from app.routes.client.members import member_bp
from app.routes.client.devices import client_bp

app = Flask(__name__)
app.register_blueprint(auth_bp)
app.register_blueprint(member_bp)
app.register_blueprint(client_bp)
c = app.test_client()

MASTER, GUEST, DEV = "u-master", "u-guest", "dev-0001"
with _db.Session() as s:
    m_jti, g_jti = str(uuid.uuid4()), str(uuid.uuid4())
    s.add(User(user_uuid=MASTER, user_name="master", secret_key="x", current_jti=m_jti))
    s.add(User(user_uuid=GUEST, user_name="guest", secret_key="x", current_jti=g_jti))
    s.add(DeviceManagement(device_uuid=DEV, device_secret_key="k", device_token="t",
                           ble_service_uuid="s", ble_write_uuid="w", ble_read_uuid="r",
                           ble_manufacturer_uuid="m"))
    s.add(UserDeviceMapping(user_uuid=MASTER, device_uuid=DEV, display_name="마스터",
                            role="master", device_nickname="우리집 도어락"))
    s.commit()

def tok(sub, jti):
    return jwt.encode({"sub": sub, "jti": jti,
                       "exp": datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(hours=1)},
                      os.environ["JWT_SECRET"], algorithm="HS256")

MH = {"Authorization": f"Bearer {tok(MASTER, m_jti)}"}
GH = {"Authorization": f"Bearer {tok(GUEST, g_jti)}"}

# 1) 토큰 정보 포함 게스트 초대 코드 발급
r = c.post("/client/invite-code", json={"device_uuid": DEV, "display_name": "손님", "role": "guest",
                                        "token_max_uses": 3, "token_expire_minutes": 120}, headers=MH)
assert r.status_code == 200, r.get_json()
code = r.get_json()["data"]["invite_code"]
print("[ok] 초대 코드 발급 (토큰 옵션 포함)")

# 잘못된 옵션은 거부
r = c.post("/client/invite-code", json={"device_uuid": DEV, "display_name": "x", "role": "guest",
                                        "token_max_uses": 0, "token_expire_minutes": 10}, headers=MH)
assert r.status_code == 400, r.get_json()
print("[ok] 잘못된 토큰 옵션 400")

# 중복 표시 이름 거부: 대기 중인 초대 코드와 겹칠 때
r = c.post("/client/invite-code", json={"device_uuid": DEV, "display_name": "손님", "role": "member"}, headers=MH)
assert r.status_code == 409, r.get_json()
# 대소문자만 다른 경우도 거부 + 기존 멤버 이름과 겹칠 때도 거부
r = c.post("/client/invite-code", json={"device_uuid": DEV, "display_name": "마스터", "role": "member"}, headers=MH)
assert r.status_code == 409, r.get_json()
print("[ok] 중복 표시 이름 409")

# 2) 미리보기 – 코드 소모 없이 정보 조회
r = c.get(f"/auth/invite-code/preview?invite_code={code}", headers=GH)
assert r.status_code == 200, r.get_json()
d = r.get_json()["data"]
assert d["device_nickname"] == "우리집 도어락" and d["role"] == "guest"
assert d["token_max_uses"] == 3 and d["token_expire_minutes"] == 120
r2 = c.get(f"/auth/invite-code/preview?invite_code={code}", headers=GH)
assert r2.status_code == 200, "미리보기가 코드를 소모함"
print("[ok] 미리보기 – 정보 정확, 코드 미소모")

# 3) 수락 → 매핑 + 토큰 생성
r = c.post("/auth/join", json={"invite_code": code}, headers=GH)
assert r.status_code == 200, r.get_json()
with _db.Session() as s:
    t = s.query(UserToken).filter_by(user_uuid=GUEST, device_uuid=DEV).all()
    assert len(t) == 1 and t[0].max_uses == 3, t
print("[ok] 수락 시 사전 토큰 발급")

# 사용된 코드는 미리보기에서 invalid
r = c.get(f"/auth/invite-code/preview?invite_code={code}", headers=GH)
assert r.status_code == 404 and r.get_json()["reason"] == "invalid", r.get_json()
print("[ok] 사용된 코드는 invalid")

# 같은 기기의 새 코드는 already_joined
r = c.post("/client/invite-code", json={"device_uuid": DEV, "display_name": "손님2", "role": "member"}, headers=MH)
code2 = r.get_json()["data"]["invite_code"]
r = c.get(f"/auth/invite-code/preview?invite_code={code2}", headers=GH)
assert r.status_code == 409 and r.get_json()["reason"] == "already_joined", r.get_json()
print("[ok] 이미 가입한 기기는 already_joined")

# 4) 게스트가 본인 토큰 조회
r = c.get(f"/client/guest-token?device_uuid={DEV}&guest_uuid={GUEST}", headers=GH)
assert r.status_code == 200 and len(r.get_json()["data"]) == 1, r.get_json()
print("[ok] 게스트 본인 토큰 조회")

# 멤버 목록: 마스터에게만 게스트 토큰 보유 여부 노출
r = c.get(f"/client/member?device_uuid={DEV}", headers=MH)
rows = {m["user_uuid"]: m for m in r.get_json()["data"]}
assert rows[GUEST]["has_token"] is True, rows
assert "has_token" not in rows[MASTER], rows
with _db.Session() as s2:
    s2.query(UserToken).filter_by(user_uuid=GUEST, device_uuid=DEV).update({"is_revoked": True})
    s2.commit()
r = c.get(f"/client/member?device_uuid={DEV}", headers=MH)
rows = {m["user_uuid"]: m for m in r.get_json()["data"]}
assert rows[GUEST]["has_token"] is False, rows
# 게스트 본인이 조회하면 필드 없음
r = c.get(f"/client/member?device_uuid={DEV}", headers=GH)
assert all("has_token" not in m for m in r.get_json()["data"]), r.get_json()
print("[ok] 멤버 목록 has_token 노출 규칙")

# 남의 토큰은 여전히 금지
r = c.get(f"/client/guest-token?device_uuid={DEV}&guest_uuid={MASTER}", headers=GH)
assert r.status_code == 403, r.get_json()
print("[ok] 게스트가 타인 토큰 조회 403")

# 5) 탈퇴 시 토큰까지 삭제 (회차 사용 기록 포함 – 남으면 재사용된 토큰 id가 물려받는다)
with _db.Session() as s:
    tid = s.query(UserToken).filter_by(user_uuid=GUEST, device_uuid=DEV).first().id
    s.add(TokenUsage(token_id=tid, period_key="2026-09-11#1", uses=1))
    s.commit()
r = c.delete(f"/client/device-membership?device_uuid={DEV}", headers=GH)
assert r.status_code == 200, r.get_json()
with _db.Session() as s:
    assert s.query(UserToken).filter_by(user_uuid=GUEST, device_uuid=DEV).count() == 0
    assert s.query(TokenUsage).filter_by(token_id=tid).count() == 0
    assert s.query(UserDeviceMapping).filter_by(user_uuid=GUEST, device_uuid=DEV).count() == 0
print("[ok] 탈퇴 시 토큰 정리")

# 6) 무제한(max_uses=None) 토큰이 기본값으로 1회용이 되지 않는지
with _db.Session() as s:
    t = UserToken(token_value="unlimited-check", user_uuid=GUEST, device_uuid=DEV, max_uses=None,
                  expired_at=datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1))
    s.add(t)
    s.commit()
    assert t.max_uses is None, t.max_uses
print("[ok] 무제한 토큰 max_uses NULL 유지")

# 7) 위치 갱신·기기 삭제 시 매핑된 전원에게 refresh_devices 푸시 (실제 FCM 대신 기록만)
import app.utils.fcm_utils as fcm_utils
import app.routes.client.devices as devices_route
sent = []
record = lambda uid, title, body, data=None: sent.append((uid, (data or {}).get("type")))
fcm_utils.send_to_user = devices_route.send_to_user = record

MEMBER = "u-member"
with _db.Session() as s:
    s.add(User(user_uuid=MEMBER, user_name="member", secret_key="x"))
    s.add(UserDeviceMapping(user_uuid=MEMBER, device_uuid=DEV, display_name="멤버", role="member"))
    s.commit()

loc = {"device_uuid": DEV, "latitude": 37.5, "longitude": 127.0}
assert c.post("/client/device-location", json=loc, headers=MH).status_code == 200  # 최초 등록
sent.clear()
assert c.post("/client/device-location", json={**loc, "latitude": 37.6}, headers=MH).status_code == 200
assert sorted(sent) == [(MASTER, "refresh_devices"), (MEMBER, "refresh_devices")], sent
print("[ok] 위치 갱신 시 refresh_devices 푸시")

sent.clear()
assert c.delete(f"/client/device?device_uuid={DEV}", headers=MH).status_code == 200
assert sorted(sent) == [(MASTER, "refresh_devices"), (MEMBER, "refresh_devices")], sent
print("[ok] 기기 삭제 시 refresh_devices 푸시")

shutil.rmtree(tmpdir, ignore_errors=True)
print("\nALL PASS")
