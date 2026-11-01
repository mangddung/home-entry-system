"""만료되거나 오래된 행 정리. 서버 시작 시 1회, 이후 24시간마다 돈다."""
import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_

from app.utils.database import database as _db
from app.utils.database.models import (
    ActivityLog,
    DeviceRefreshToken,
    InviteCode,
    OAuthLoginCode,
    TokenBlacklist,
    UserRefreshToken,
    UserToken,
)

logger = logging.getLogger(__name__)

LOG_RETENTION = timedelta(days=180)
# 만료 토큰은 거부 사유 알림의 요청자 식별에 쓰이므로(iot.validate_mac) 바로 지우지 않는다
EXPIRED_TOKEN_RETENTION = timedelta(days=30)
INTERVAL_SECONDS = 24 * 3600


def run_cleanup(now: datetime | None = None) -> None:
    now = now or datetime.now(timezone.utc)
    with _db.Session() as session:
        # device_reset 행도 같은 기준이라, 리셋 행이 지워질 때는 그 이전 로그도 이미 없다(/client/logs 숨김 유지)
        session.query(ActivityLog).filter(or_(
            ActivityLog.action == "device_ping",  # 이제 기록하지 않는 옛 행
            ActivityLog.created_at < now - LOG_RETENTION,
        )).delete(synchronize_session=False)

        for model in (TokenBlacklist, UserRefreshToken, DeviceRefreshToken, InviteCode, OAuthLoginCode):
            session.query(model).filter(model.expired_at < now).delete(synchronize_session=False)

        # 일괄 delete()는 ORM cascade를 건너뛰어 token_usages가 고아로 남으므로 하나씩 지운다
        for token in session.query(UserToken).filter(UserToken.expired_at < now - EXPIRED_TOKEN_RETENTION).all():
            session.delete(token)

        session.commit()


def start_cleanup_loop() -> None:
    def loop():
        while True:
            try:
                run_cleanup()
            except Exception:
                logger.exception("cleanup failed")
            time.sleep(INTERVAL_SECONDS)

    threading.Thread(target=loop, daemon=True, name="db-cleanup").start()
