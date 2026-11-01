"""개발용 Zigbee 게이트웨이(Zigbee2MQTT + ZBDongle-P) 준비. 다시 실행해도 기존 비밀번호·설정을 유지한다.

  1) MQTT 비밀번호: server/.env(MQTT_*)·gateway/z2m/data/secret.yaml에 없으면 생성 (화면에 출력하지 않음)
  2) Mosquitto 계정 파일 mosquitto/config/passwd (server, <gateway_id>)
  3) Z2M data/configuration.yaml (없을 때만 configuration.example.yaml로 생성)
  4) 서버 DB에 게이트웨이 등록 (permit join 대상)
  5) docker compose -f docker-compose.dev.yml up -d (계정 반영을 위해 재생성)

사용: server/.venv/Scripts/python.exe gateway/setup_dev_gateway.py --port COM8
"""
import argparse
import os
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "server"
ENV = SERVER / ".env"
Z2M_DATA = ROOT / "gateway" / "z2m" / "data"
MOSQUITTO_IMAGE = "eclipse-mosquitto:2.0.22"


def read_env() -> dict:
    if not ENV.exists():
        return {}
    pairs = (line.split("=", 1) for line in ENV.read_text(encoding="utf-8").splitlines() if "=" in line)
    return {k.strip(): v.strip() for k, v in pairs}


def ensure_server_password() -> str:
    env = read_env()
    if env.get("MQTT_PASSWORD"):
        return env["MQTT_PASSWORD"]
    password = secrets.token_urlsafe(24)
    with ENV.open("a", encoding="utf-8") as f:
        f.write("\n# Zigbee 모델 MQTT (gateway/setup_dev_gateway.py)\n"
                "MQTT_HOST=127.0.0.1\nMQTT_PORT=15883\nMQTT_USER=server\n"
                f"MQTT_PASSWORD={password}\n")
    print("server/.env: MQTT_* added")
    return password


def ensure_gateway_password() -> str:
    secret = Z2M_DATA / "secret.yaml"
    if secret.exists():
        m = re.search(r"^mqtt_password:\s*(\S+)", secret.read_text(encoding="utf-8"), re.M)
        if m:
            return m.group(1)
    Z2M_DATA.mkdir(parents=True, exist_ok=True)
    password = secrets.token_urlsafe(24)
    secret.write_text(f"mqtt_password: {password}\n", encoding="utf-8")
    print("gateway/z2m/data/secret.yaml created")
    return password


def write_passwd(gateway_id: str, server_pw: str, gateway_pw: str):
    # 비밀번호는 명령줄이 아니라 환경변수로 컨테이너에 넘긴다
    env = dict(os.environ, P_SERVER=server_pw, P_GATEWAY=gateway_pw)
    subprocess.run(
        ["docker", "run", "--rm", "-e", "P_SERVER", "-e", "P_GATEWAY",
         "-v", f"{ROOT / 'mosquitto' / 'config'}:/work", MOSQUITTO_IMAGE, "sh", "-c",
         f'mosquitto_passwd -b -c /work/passwd server "$P_SERVER" && '
         f'mosquitto_passwd -b /work/passwd {gateway_id} "$P_GATEWAY" && '
         # 브로커는 mosquitto(1883) 사용자로 돈다. root 소유 0600이면 못 읽는다
         'chown 1883:1883 /work/passwd /work/acl && chmod 0600 /work/passwd /work/acl'],
        env=env, check=True)
    print("mosquitto/config/passwd written (server, %s)" % gateway_id)


def ensure_z2m_config(gateway_id: str, port: str):
    config = Z2M_DATA / "configuration.yaml"
    if config.exists():
        print("gateway/z2m/data/configuration.yaml exists – left as is")
        return
    text = (ROOT / "gateway" / "z2m" / "configuration.example.yaml").read_text(encoding="utf-8")
    text = text.replace("COM_PORT", port).replace("gw-dev", gateway_id)
    config.write_text(text, encoding="utf-8")
    print("gateway/z2m/data/configuration.yaml created")


def register_gateway(gateway_id: str):
    sys.path.insert(0, str(SERVER))
    os.chdir(SERVER)
    from app.utils.database import database as _db
    from app.utils.database.models import Gateway
    _db.init_db()
    with _db.Session() as session:
        if not session.get(Gateway, gateway_id):
            session.add(Gateway(gateway_id=gateway_id))
            session.commit()
    print(f"gateway '{gateway_id}' registered in server DB")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", required=True, help="dongle serial port, e.g. COM8")
    parser.add_argument("--gateway-id", default="gw-dev")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,48}", args.gateway_id):
        sys.exit("invalid gateway id")

    server_pw = ensure_server_password()
    gateway_pw = ensure_gateway_password()
    write_passwd(args.gateway_id, server_pw, gateway_pw)
    ensure_z2m_config(args.gateway_id, args.port)
    register_gateway(args.gateway_id)
    subprocess.run(["docker", "compose", "-f", str(ROOT / "docker-compose.dev.yml"), "up", "-d", "--force-recreate"],
                   check=True)
    if not shutil.which("npm"):
        print("WARNING: npm not found (Zigbee2MQTT needs Node.js)")
    print("\nNext: cd gateway/z2m && npm ci && npm start")


if __name__ == "__main__":
    main()
