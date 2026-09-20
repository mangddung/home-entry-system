from datetime import datetime, timezone
from sqlalchemy import Column, String, Text, BigInteger, DateTime, ForeignKey, Integer, Float, PrimaryKeyConstraint, Boolean, UniqueConstraint
from sqlalchemy.orm import relationship

from app.utils.database.database import Base


class User(Base):
    __tablename__ = "users"

    user_uuid  = Column(String(50), primary_key=True)
    user_name  = Column(String(50), nullable=False, unique=True)
    secret_key = Column(String(255), nullable=False)
    fcm_token  = Column(String(255), nullable=True)
    current_jti = Column(String(36), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    oauth_tokens    = relationship("KakaoOAuthToken", back_populates="user", cascade="all, delete-orphan")
    user_tokens     = relationship("UserToken", back_populates="user", cascade="all, delete-orphan")
    refresh_tokens  = relationship("UserRefreshToken", back_populates="user", cascade="all, delete-orphan")
    invite_codes = relationship("InviteCode", back_populates="creator", foreign_keys="InviteCode.creator_uuid", cascade="all, delete-orphan")
    device_mappings = relationship("UserDeviceMapping", back_populates="user", cascade="all, delete-orphan")


class KakaoOAuthToken(Base):
    __tablename__ = "kakao_oauth_tokens"

    id            = Column(Integer, primary_key=True, autoincrement=True)
    user_uuid     = Column(String(50), ForeignKey("users.user_uuid", ondelete="CASCADE"), nullable=False)
    kakao_user_id = Column(BigInteger, nullable=False, unique=True)
    access_token  = Column(Text, nullable=False)
    refresh_token = Column(Text, nullable=True)
    token_type    = Column(String(50), default="bearer")
    expires_at    = Column(DateTime, nullable=True)
    scope         = Column(Text, nullable=True)
    created_at    = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at    = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    user = relationship("User", back_populates="oauth_tokens")


class UserToken(Base):
    __tablename__ = "user_tokens"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    token_value = Column(String(255), nullable=False, unique=True)
    user_uuid   = Column(String(50), ForeignKey("users.user_uuid", ondelete="CASCADE"), nullable=False)
    device_uuid = Column(String(50), ForeignKey("device_management.device_uuid", ondelete="CASCADE"), nullable=False)
    # NULL = 전체 횟수 제한 없음(스케줄 토큰). default를 두면 SQLAlchemy가 None을
    # "값 없음"으로 보고 기본값을 채워 무제한 토큰이 1회용이 되므로 두지 않는다.
    max_uses    = Column(Integer, nullable=True)
    use_count   = Column(Integer, default=0)
    is_revoked = Column(Boolean, default=False, nullable=False)
    not_before  = Column(DateTime, nullable=True)
    expired_at  = Column(DateTime, nullable=False)
    # 반복 사용 규칙(요일·시간대·회차별 횟수). NULL이면 제약 없음.
    schedule_json = Column(Text, nullable=True)
    schedule_tz   = Column(String(64), nullable=True)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    user = relationship("User", back_populates="user_tokens")
    device = relationship("DeviceManagement", back_populates="user_tokens")
    usages = relationship("TokenUsage", back_populates="token", cascade="all, delete-orphan")


class TokenUsage(Base):
    """스케줄 창 회차별 사용 횟수. period_key = "<창 시작 로컬 날짜>#<window id>"."""
    __tablename__ = "token_usages"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    token_id   = Column(Integer, ForeignKey("user_tokens.id", ondelete="CASCADE"), nullable=False)
    period_key = Column(String(32), nullable=False)
    uses       = Column(Integer, default=0, nullable=False)

    token = relationship("UserToken", back_populates="usages")

    __table_args__ = (UniqueConstraint("token_id", "period_key", name="uq_token_period"),)


class DeviceManagement(Base):
    __tablename__ = "device_management"

    device_uuid       = Column(String(50), primary_key=True)
    device_secret_key = Column(String(255), nullable=False, unique=True)
    device_token      = Column(String(255), nullable=False, unique=True)
    setup_token       = Column(String(255), nullable=True, unique=True)
    setup_user_uuid   = Column(String(50), nullable=True)   # /client/setup-token 요청자 = 설정 완료 시 master
    setup_requested_at = Column(DateTime, nullable=True)
    ble_service_uuid     = Column(String(255), nullable=False, unique=True)
    ble_write_uuid        = Column(String(255), nullable=False, unique=True)
    ble_read_uuid         = Column(String(255), nullable=False, unique=True)
    ble_manufacturer_uuid = Column(String(255), nullable=True, unique=True)
    last_ping_at          = Column(DateTime, nullable=True)
    current_jti           = Column(String(36), nullable=True)

    settings        = relationship("Settings", back_populates="device", cascade="all, delete-orphan")
    location        = relationship("DeviceLocation", back_populates="device", cascade="all, delete-orphan", uselist=False)
    invite_codes = relationship("InviteCode", back_populates="device", foreign_keys="InviteCode.device_uuid", cascade="all, delete-orphan")
    user_mappings   = relationship("UserDeviceMapping", back_populates="device", cascade="all, delete-orphan")
    user_tokens     = relationship("UserToken", back_populates="device", cascade="all, delete-orphan")
    refresh_tokens  = relationship("DeviceRefreshToken", back_populates="device", cascade="all, delete-orphan")


class Settings(Base):
    __tablename__ = "settings"

    device_uuid      = Column(String(50), ForeignKey("device_management.device_uuid", ondelete="CASCADE"), primary_key=True)
    rssi_threshold   = Column(Integer, nullable=False)
    motor_down_level = Column(Float, nullable=False)
    motor_up_level   = Column(Float, nullable=False)

    device = relationship("DeviceManagement", back_populates="settings")


class DeviceLocation(Base):
    __tablename__ = "device_location"

    device_uuid  = Column(String(50), ForeignKey("device_management.device_uuid", ondelete="CASCADE"), primary_key=True)
    latitude     = Column(Float, nullable=False)
    longitude    = Column(Float, nullable=False)

    device = relationship("DeviceManagement", back_populates="location")


class InviteCode(Base):
    __tablename__ = "invite_codes"

    invite_code  = Column(String(255), primary_key=True)
    device_uuid  = Column(String(50), ForeignKey("device_management.device_uuid", ondelete="CASCADE"), nullable=True)
    creator_uuid = Column(String(50), ForeignKey("users.user_uuid", ondelete="CASCADE"), nullable=True)
    display_name = Column(String(100), nullable=False)
    role        = Column(String(10), nullable=False, default="guest")
    is_used     = Column(Boolean, default=False)
    expired_at   = Column(DateTime, nullable=True)
    created_at   = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    # 게스트 초대 시 미리 지정하는 토큰 정보 (NULL이면 가입 시 토큰 발급 안 함)
    token_max_uses       = Column(Integer, nullable=True)
    token_expire_minutes = Column(Integer, nullable=True)
    token_not_before     = Column(DateTime, nullable=True)

    device  = relationship("DeviceManagement", back_populates="invite_codes", foreign_keys=[device_uuid])
    creator = relationship("User", back_populates="invite_codes", foreign_keys=[creator_uuid])


class UserRefreshToken(Base):
    __tablename__ = "user_refresh_tokens"

    token_value = Column(String(255), primary_key=True)
    user_uuid   = Column(String(50), ForeignKey("users.user_uuid", ondelete="CASCADE"), nullable=False)
    expired_at  = Column(DateTime, nullable=False)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    user = relationship("User", back_populates="refresh_tokens")


class DeviceRefreshToken(Base):
    __tablename__ = "device_refresh_tokens"

    token_value = Column(String(255), primary_key=True)
    device_uuid = Column(String(50), ForeignKey("device_management.device_uuid", ondelete="CASCADE"), nullable=False)
    expired_at  = Column(DateTime, nullable=False)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    device = relationship("DeviceManagement", back_populates="refresh_tokens")


class TokenBlacklist(Base):
    __tablename__ = "token_blacklist"

    jti        = Column(String(36), primary_key=True)
    expired_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class ActivityLog(Base):
    __tablename__ = "activity_logs"

    id          = Column(Integer, primary_key=True, autoincrement=True)
    user_uuid   = Column(String(50), ForeignKey("users.user_uuid", ondelete="SET NULL"), nullable=True)
    device_uuid = Column(String(50), ForeignKey("device_management.device_uuid", ondelete="SET NULL"), nullable=True)
    action      = Column(String(50), nullable=False)
    detail      = Column(Text, nullable=True)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))


class UserDeviceMapping(Base):
    __tablename__ = "user_device_mappings"
    __table_args__ = (
        PrimaryKeyConstraint("user_uuid", "device_uuid"),
    )

    user_uuid   = Column(String(50), ForeignKey("users.user_uuid", ondelete="CASCADE"))
    device_uuid = Column(String(50), ForeignKey("device_management.device_uuid", ondelete="CASCADE"))
    display_name = Column(String(100), nullable=False)
    role        = Column(String(10), nullable=False, default="guest")
    device_nickname = Column(String(100), nullable=True)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    user   = relationship("User", back_populates="device_mappings")
    device = relationship("DeviceManagement", back_populates="user_mappings")
