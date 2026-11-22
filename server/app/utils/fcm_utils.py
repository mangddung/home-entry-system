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
        # notification을 싣지 않는다. 실으면 앱이 백그라운드일 때 시스템이 알림을 직접 띄우고 앱 핸들러도
        # (피드백 버튼을 단) 알림을 띄워 두 번 뜬다. 제목·본문은 data로 보내고 앱(notifee)이 한 번만 띄운다.
        # data 전용 메시지는 기본 우선순위가 normal이라 Doze에서 늦게 오므로 high로 보낸다.
        # ponytail: iOS는 data 전용이면 표시되지 않는다(apns content-available 필요). iOS 배포 때 추가.
        messaging.send(messaging.Message(
            data={**(data or {}), "title": title, "body": body},
            android=messaging.AndroidConfig(priority="high"),
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
