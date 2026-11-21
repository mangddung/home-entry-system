"""Flask(gunicorn worker)에서 MQTT로 한 번씩 발행할 때 쓴다. 구독·기기 메시지 처리는 mqtt_worker.py(별도 프로세스).

토픽은 Zigbee2MQTT 형식: homes/<gateway_id>/... (Z2M base_topic = homes/<gateway_id>)
"""
import json
import logging
import os
import threading

import paho.mqtt.publish as mqtt_publish

from app.utils.database import database as _db
from app.utils.database.models import Gateway

log = logging.getLogger(__name__)

PERMIT_JOIN_SECONDS = 180


def mqtt_settings() -> dict:
    return {
        "hostname": os.environ.get("MQTT_HOST", "127.0.0.1"),
        "port": int(os.environ.get("MQTT_PORT", "15883")),
        "auth": {"username": os.environ.get("MQTT_USER", ""), "password": os.environ.get("MQTT_PASSWORD", "")},
    }


def publish_json(topic: str, payload: dict) -> bool:
    try:
        mqtt_publish.single(topic, json.dumps(payload), qos=1, **mqtt_settings())
        return True
    except Exception as e:  # 브로커가 내려가 있어도 HTTP 요청은 계속 처리한다
        log.warning("MQTT publish failed (%s): %s", topic, e)
        return False


CHECK_REG = 0x85  # esp32/main/transport_zigbee.c ZB_MSG_CHECK_REG


def notify_zigbee_check_registration(gateway_id: str, ieee_addr: str):
    """삭제된 Zigbee 기기에 '바로 ping 하라'는 신호를 보낸다(태그 없음: 초기화는 기기가 ping 응답을 보고 한다).
    잠든 기기에 못 닿으면 다음 정기 ping(최대 5분)에서 초기화된다. 요청 스레드를 막지 않게 백그라운드로 발행한다."""
    payload = {"doorlock_rsp": bytes([CHECK_REG, 0]).hex()}
    threading.Thread(target=publish_json, args=(f"homes/{gateway_id}/{ieee_addr}/set", payload), daemon=True).start()


def open_zigbee_join():
    """Zigbee 기기 셋업 시작: 게이트웨이 네트워크 가입을 잠시 허용한다. 요청 스레드를 막지 않게 백그라운드로 발행한다.
    ponytail: 등록된 게이트웨이 전부를 연다(현 단계 개발 게이트웨이 1대). 앱에 게이트웨이 선택이 들어오면
    사용자가 고른 게이트웨이만 연다."""
    with _db.Session() as session:
        gateway_ids = [g.gateway_id for g in session.query(Gateway).all()]

    def run():
        for gw in gateway_ids:
            publish_json(f"homes/{gw}/bridge/request/permit_join", {"time": PERMIT_JOIN_SECONDS})

    threading.Thread(target=run, daemon=True).start()
