import json
from app.utils.database import database as _db
from app.utils.database.models import ActivityLog


def log_activity(action: str, user_uuid: str = None, device_uuid: str = None, detail: dict = None, session=None):
    entry = ActivityLog(
        user_uuid=user_uuid,
        device_uuid=device_uuid,
        action=action,
        detail=json.dumps(detail) if detail else None,
    )
    if session:
        session.add(entry)
    else:
        with _db.Session() as s:
            s.add(entry)
            s.commit()
