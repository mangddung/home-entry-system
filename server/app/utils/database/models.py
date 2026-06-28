from datetime import datetime, timezone
from sqlalchemy import Column, String, Text, BigInteger, DateTime, ForeignKey, Integer, Float, PrimaryKeyConstraint, Boolean
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
    max_uses    = Column(Integer, default=1)
    use_count   = Column(Integer, default=0)
    is_revoked = Column(Boolean, default=False, nullable=False)
    not_before  = Column(DateTime, nullable=True)
    expired_at  = Column(DateTime, nullable=False)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    user = relationship("User", back_populates="user_tokens")
    device = relationship("DeviceManagement", back_populates="user_tokens")


class DeviceManagement(Base):
    __tablename__ = "device_management"

    device_uuid       = Column(String(50), primary_key=True)
    device_secret_key = Column(String(255), nullable=False, unique=True)
    device_token      = Column(String(255), nullable=False, unique=True)
    setup_token       = Column(String(255), nullable=True, unique=True)
    ble_service_uuid      = Column(String(255), nullable=False, unique=True)
    ble_write_uuid        = Column(String(255), nullable=False, unique=True)
    ble_read_uuid         = Column(String(255), nullable=False, unique=True)
    ble_manufacturer_uuid = Column(String(255), nullable=True, unique=True)
    last_ping_at          = Column(DateTime, nullable=True)

    settings        = relationship("Settings", back_populates="device", cascade="all, delete-orphan")
    location        = relationship("DeviceLocation", back_populates="device", cascade="all, delete-orphan", uselist=False)
    invite_codes = relationship("InviteCode", back_populates="device", foreign_keys="InviteCode.device_uuid", cascade="all, delete-orphan")
    user_mappings   = relationship("UserDeviceMapping", back_populates="device", cascade="all, delete-orphan")
    user_tokens     = relationship("UserToken", back_populates="device", cascade="all, delete-orphan")


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
    range_meter  = Column(Float, nullable=False)

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

    device  = relationship("DeviceManagement", back_populates="invite_codes", foreign_keys=[device_uuid])
    creator = relationship("User", back_populates="invite_codes", foreign_keys=[creator_uuid])


class UserRefreshToken(Base):
    __tablename__ = "user_refresh_tokens"

    token_value = Column(String(255), primary_key=True)
    user_uuid   = Column(String(50), ForeignKey("users.user_uuid", ondelete="CASCADE"), nullable=False)
    expired_at  = Column(DateTime, nullable=False)
    created_at  = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    user = relationship("User", back_populates="refresh_tokens")


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
