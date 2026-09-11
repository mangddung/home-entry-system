from pathlib import Path
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, declarative_base

Base = declarative_base()

engine = None
Session = None

_DATA_DIR = Path(__file__).resolve().parents[3] / "data"
_DB_PATH  = _DATA_DIR / "app.db"

def init_db():
    global engine, Session

    _DATA_DIR.mkdir(exist_ok=True)

    engine = create_engine(f"sqlite:///{_DB_PATH}", connect_args={"check_same_thread": False})

    import importlib
    importlib.import_module("app.utils.database.models")

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

    Session = sessionmaker(bind=engine)
