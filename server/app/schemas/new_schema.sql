-- token : hashed
-- secret_key : encrypted by KEK

-- 1. User Table
CREATE TABLE IF NOT EXISTS users (
    user_uuid VARCHAR(50) PRIMARY KEY,
    user_name VARCHAR(50) NOT NULL UNIQUE,
    secret_key VARCHAR(255) NOT NULL, -- ENCRYPTED SECRET KEY
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. User Token Management Table
CREATE TABLE IF NOT EXISTS user_tokens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    token_value VARCHAR(255) NOT NULL UNIQUE, -- HASHED TOKEN VALUE
    user_uuid VARCHAR(50),
    max_uses INT DEFAULT 1,
    use_count INT DEFAULT 0,
    not_before DATETIME,
    expired_at DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid) ON DELETE CASCADE
);

-- 3. Device Environment Management Table
CREATE TABLE IF NOT EXISTS device_management (
    device_uuid VARCHAR(50) PRIMARY KEY,
    device_secret_key VARCHAR(255) NOT NULL UNIQUE, -- ENCRYPTED SECRET KEY
    device_token VARCHAR(255) NOT NULL UNIQUE, -- HASHED TOKEN VALUE
    ble_service_uuid VARCHAR(255) NOT NULL UNIQUE,
    ble_write_uuid VARCHAR(255) NOT NULL UNIQUE,
    ble_read_uuid VARCHAR(255) NOT NULL UNIQUE,
    ble_manufacturer_uuid VARCHAR(255) UNIQUE,
    current_jti VARCHAR(36)
);

-- 4. Settings Management Table
CREATE TABLE IF NOT EXISTS settings (
    device_uuid VARCHAR(50) PRIMARY KEY,
    rssi_threshold INT NOT NULL,
    motor_down_level DOUBLE NOT NULL,
    motor_up_level DOUBLE NOT NULL,

    FOREIGN KEY (device_uuid) REFERENCES device_management(device_uuid) ON DELETE CASCADE
);

-- 5. Register Token Management Table
CREATE TABLE IF NOT EXISTS register_tokens (
    token_value VARCHAR(255) PRIMARY KEY, -- HASHED TOKEN VALUE
    device_uuid VARCHAR(50),
    creator_uuid VARCHAR(50),
    max_uses INT DEFAULT 1,
    use_count INT DEFAULT 0,
    not_before DATETIME,
    expired_at DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (device_uuid) REFERENCES device_management(device_uuid) ON DELETE CASCADE,
    FOREIGN KEY (creator_uuid) REFERENCES users(user_uuid) ON DELETE CASCADE
);

-- 6. User Device Mapping Table
CREATE TABLE IF NOT EXISTS user_device_mappings (
    user_uuid VARCHAR(50),
    device_uuid VARCHAR(50),
    role ENUM('master', 'member', 'guest') NOT NULL DEFAULT 'guest',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (user_uuid, device_uuid),
    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid) ON DELETE CASCADE,
    FOREIGN KEY (device_uuid) REFERENCES device_management(device_uuid) ON DELETE CASCADE
);

-- 7. User Refresh Token Table
CREATE TABLE IF NOT EXISTS user_refresh_tokens (
    token_value VARCHAR(255) PRIMARY KEY,
    user_uuid   VARCHAR(50) NOT NULL,
    expired_at  DATETIME NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid) ON DELETE CASCADE
);

-- 8. Token Blacklist Table
CREATE TABLE IF NOT EXISTS token_blacklist (
    jti        VARCHAR(36) PRIMARY KEY,
    expired_at DATETIME NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. Device Refresh Token Table
CREATE TABLE IF NOT EXISTS device_refresh_tokens (
    token_value VARCHAR(255) PRIMARY KEY,
    device_uuid VARCHAR(50) NOT NULL,
    expired_at  DATETIME NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (device_uuid) REFERENCES device_management(device_uuid) ON DELETE CASCADE
);

-- 10. Kakao OAuth Token Table
CREATE TABLE IF NOT EXISTS kakao_oauth_tokens (
    id             INT AUTO_INCREMENT PRIMARY KEY,
    user_uuid      VARCHAR(50) NOT NULL,
    kakao_user_id  BIGINT NOT NULL UNIQUE,
    access_token   TEXT NOT NULL,
    refresh_token  TEXT,
    token_type     VARCHAR(50) DEFAULT 'bearer',
    expires_at     DATETIME,
    scope          TEXT,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    FOREIGN KEY (user_uuid) REFERENCES users(user_uuid) ON DELETE CASCADE
);