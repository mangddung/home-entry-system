import logging
from firebase_admin import messaging

from app.utils.database import database as _db
from app.utils.database.models import User, UserDeviceMapping

logger = logging.getLogger(__name__)


def send_to_user(user_uuid: str, title: str, body: str, data: dict | None = None):
    """data는 앱 백그라운드 핸들러가 읽는 값(FCM 규격상 값은 문자열만)."""
    with _db.Session() as session:
        user = session.query(User).filter_by(user_uuid=user_uuid).first()
        if not user or not user.fcm_token:
            return

    try:
        messaging.send(messaging.Message(
            notification=messaging.Notification(title=title, body=body),
            data=data,
            token=user.fcm_token,
        ))
    except Exception as e:
        logger.warning(f"FCM send failed for user {user_uuid}: {e}")


def send_to_device_master(device_uuid: str, title: str, body: str, data: dict | None = None):
    with _db.Session() as session:
        master = session.query(UserDeviceMapping).filter_by(device_uuid=device_uuid, role="master").first()
        if not master:
            return
        master_uuid = master.user_uuid

    send_to_user(master_uuid, title, body, data)


def send_to_device_role(device_uuid: str, role: str | list[str], title: str, body: str, data: dict | None = None):
    roles = role if isinstance(role, list) else [role]
    with _db.Session() as session:
        mappings = session.query(UserDeviceMapping).filter(
            UserDeviceMapping.device_uuid == device_uuid,
            UserDeviceMapping.role.in_(roles),
        ).all()
        user_uuids = [m.user_uuid for m in mappings]

    for user_uuid in user_uuids:
        send_to_user(user_uuid, title, body, data=data)
