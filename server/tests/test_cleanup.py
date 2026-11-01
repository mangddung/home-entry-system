"""만료·오래된 행 정리 조건. 임시 DB만 사용, 네트워크 없음."""
import os, sys, tempfile, pathlib
from datetime import datetime, timedelta, timezone
from dotenv import load_dotenv

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))
os.chdir(SERVER)
load_dotenv()

from app.utils.database import database as _db

tmpdir = pathlib.Path(tempfile.mkdtemp())
_db._DATA_DIR = tmpdir
_db._DB_PATH = tmpdir / "app.db"
_db.init_db()

from app.utils.cleanup import run_cleanup
from app.utils.database.models import (
    ActivityLog, DeviceManagement, DeviceRefreshToken, InviteCode, OAuthLoginCode,
    TokenBlacklist, TokenUsage, User, UserRefreshToken, UserToken,
)

now = datetime.now(timezone.utc)
past, future = now - timedelta(seconds=10), now + timedelta(hours=1)
U, D = "u-1", "dev-1"


def token(value, expired_at):
    return UserToken(token_value=value, user_uuid=U, device_uuid=D, expired_at=expired_at)


with _db.Session() as s:
    s.add(User(user_uuid=U, user_name=U, secret_key="k"))
    s.add(DeviceManagement(device_uuid=D, device_secret_key="sk", device_token="t",
                           ble_service_uuid="s", ble_read_uuid="r", ble_write_uuid="w"))
    s.flush()
    s.add_all([
        ActivityLog(device_uuid=D, action="device_ping", created_at=now),
        ActivityLog(device_uuid=D, action="old_log", created_at=now - timedelta(days=181)),
        ActivityLog(device_uuid=D, action="device_reset", created_at=now - timedelta(days=181)),
        ActivityLog(device_uuid=D, action="kept_log", created_at=now - timedelta(days=179)),
        TokenBlacklist(jti="old", expired_at=past), TokenBlacklist(jti="live", expired_at=future),
        UserRefreshToken(token_value="old", user_uuid=U, expired_at=past),
        UserRefreshToken(token_value="live", user_uuid=U, expired_at=future),
        DeviceRefreshToken(token_value="old", device_uuid=D, expired_at=past),
        DeviceRefreshToken(token_value="live", device_uuid=D, expired_at=future),
        InviteCode(invite_code="old", device_uuid=D, display_name="a", expired_at=past),
        InviteCode(invite_code="live", device_uuid=D, display_name="b", expired_at=future),
        OAuthLoginCode(code="old", user_uuid=U, state="s", expired_at=past),
        OAuthLoginCode(code="live", user_uuid=U, state="s", expired_at=future),
    ])
    old_token = token("old", now - timedelta(days=31))
    recent_token = token("recent", now - timedelta(days=29))
    s.add_all([old_token, recent_token])
    s.flush()
    s.add(TokenUsage(token_id=old_token.id, period_key="p", uses=1))
    s.commit()

run_cleanup(now)

with _db.Session() as s:
    actions = {l.action for l in s.query(ActivityLog)}
    assert actions == {"kept_log"}, actions
    print("[ok] ping 로그와 180일 지난 로그만 지운다")

    for model, key in ((TokenBlacklist, "jti"), (UserRefreshToken, "token_value"),
                       (DeviceRefreshToken, "token_value"), (InviteCode, "invite_code"), (OAuthLoginCode, "code")):
        kept = [getattr(r, key) for r in s.query(model)]
        assert kept == ["live"], (model.__name__, kept)
    print("[ok] 만료된 블랙리스트·refresh 토큰·초대 코드·로그인 코드만 지운다")

    assert [t.token_value for t in s.query(UserToken)] == ["recent"]
    print("[ok] 사용자 토큰은 만료 후 30일이 지나야 지운다")

    assert s.query(TokenUsage).count() == 0
    print("[ok] 지운 토큰의 사용 횟수도 함께 지운다")

print("\n전체 통과")
