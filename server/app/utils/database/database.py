import time
from pathlib import Path
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import sessionmaker, declarative_base

Base = declarative_base()

engine = None
Session = None

_DATA_DIR = Path(__file__).resolve().parents[3] / "data"
_DB_PATH  = _DATA_DIR / "app.db"

SCHEMA_ATTEMPTS = 5

def init_db():
    global engine, Session

    _DATA_DIR.mkdir(exist_ok=True)

    engine = create_engine(f"sqlite:///{_DB_PATH}", connect_args={"check_same_thread": False})

    import importlib
    importlib.import_module("app.utils.database.models")

    # 서버와 MQTT 워커가 동시에 시작하면 같은 테이블·컬럼을 함께 만들다 부딪힌다.
    # 각 단계가 존재 여부를 먼저 보므로 다시 돌리면 남은 것만 이어서 끝낸다.
    for attempt in range(SCHEMA_ATTEMPTS):
        try:
            _apply_schema()
            break
        except OperationalError:
            if attempt == SCHEMA_ATTEMPTS - 1:
                raise
            time.sleep(0.5)

    Session = sessionmaker(bind=engine)


def _apply_schema():
    inspector = inspect(engine)
    existing  = set(inspector.get_table_names())
    missing   = {t for t in Base.metadata.tables if t not in existing}

    if missing:
        Base.metadata.create_all(engine, tables=[Base.metadata.tables[t] for t in missing])

    existing_cols = {c["name"] for c in inspector.get_columns("users")}
    if "current_jti" not in existing_cols:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE users ADD COLUMN current_jti VARCHAR(36)"))
            conn.commit()

    existing_device_cols = {c["name"] for c in inspector.get_columns("device_management")}
    if "current_jti" not in existing_device_cols:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE device_management ADD COLUMN current_jti VARCHAR(36)"))
            conn.commit()

    # 기기 설정 요청자 점유 (setup_token 발급 시 기록, 설정 완료/리셋 시 행 재생성으로 초기화)
    # rssi_threshold: 근접 해제 기기 임계값 (NULL이면 앱이 첫 발견 즉시 연결)
    for col, ddl in (
        ("setup_user_uuid",    "ALTER TABLE device_management ADD COLUMN setup_user_uuid VARCHAR(50)"),
        ("setup_requested_at", "ALTER TABLE device_management ADD COLUMN setup_requested_at DATETIME"),
        ("rssi_threshold",     "ALTER TABLE device_management ADD COLUMN rssi_threshold INTEGER"),
        ("battery_mv",         "ALTER TABLE device_management ADD COLUMN battery_mv INTEGER"),
        # Zigbee 모델 추가: 기존 기기는 모두 Wi-Fi 모델
        ("transport",  "ALTER TABLE device_management ADD COLUMN transport VARCHAR(10) NOT NULL DEFAULT 'wifi'"),
        ("ieee_addr",  "ALTER TABLE device_management ADD COLUMN ieee_addr VARCHAR(18)"),
        ("gateway_id", "ALTER TABLE device_management ADD COLUMN gateway_id VARCHAR(50)"),
    ):
        if col not in existing_device_cols:
            with engine.connect() as conn:
                conn.execute(text(ddl))
                conn.commit()
    # SQLite는 ADD COLUMN에 UNIQUE를 못 붙여 인덱스로 건다(새 DB는 create_all이 이미 만든 상태)
    with engine.connect() as conn:
        conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS ix_device_management_ieee_addr ON device_management (ieee_addr)"))
        conn.commit()

    # geofence 반경은 앱에서 상수로 고정되어 더 이상 저장하지 않는다.
    # 컬럼이 NOT NULL로 남아 있으면 모델에서 빠진 뒤 INSERT가 실패하므로 제거한다.
    # (SQLite 3.35+ 의 DROP COLUMN 필요)
    location_cols = {c["name"] for c in inspect(engine).get_columns("device_location")}
    if "range_meter" in location_cols:
        with engine.connect() as conn:
            conn.execute(text("ALTER TABLE device_location DROP COLUMN range_meter"))
            conn.commit()

    # 게스트 초대 코드에 사전 토큰 정보를 담기 위한 컬럼 (NULL이면 토큰 발급 없음)
    invite_cols = {c["name"] for c in inspect(engine).get_columns("invite_codes")}
    for col, ddl in (
        ("token_max_uses",       "ALTER TABLE invite_codes ADD COLUMN token_max_uses INTEGER"),
        ("token_expire_minutes", "ALTER TABLE invite_codes ADD COLUMN token_expire_minutes INTEGER"),
        ("token_not_before",     "ALTER TABLE invite_codes ADD COLUMN token_not_before DATETIME"),
    ):
        if col not in invite_cols:
            with engine.connect() as conn:
                conn.execute(text(ddl))
                conn.commit()

    # 게스트 토큰 반복 사용 규칙 (NULL이면 제약 없음)
    token_cols = {c["name"] for c in inspect(engine).get_columns("user_tokens")}
    for col, ddl in (
        ("schedule_json", "ALTER TABLE user_tokens ADD COLUMN schedule_json TEXT"),
        ("schedule_tz",   "ALTER TABLE user_tokens ADD COLUMN schedule_tz VARCHAR(64)"),
    ):
        if col not in token_cols:
            with engine.connect() as conn:
                conn.execute(text(ddl))
                conn.commit()
