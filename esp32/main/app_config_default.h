#pragma once

// ── WiFi ────────────────────────────────────────────────────────────────────
// SSID/PW는 초기 설정 완료 후 NVS에 저장됨 (device_config_t g_cfg.wifi_ssid/wifi_password)
#define WIFI_MAX_RETRY 10

// ── Device identity ─────────────────────────────────────────────────────────
// Fixed: never change after provisioning
#define IOT_DEVICE_UUID       ""
#define IOT_DEVICE_SECRET_KEY ""

// Dynamic defaults (runtime values live in device_config_t g_cfg)
#define IOT_DEVICE_TOKEN_DEFAULT ""

// ── Initial Setup (provisioning) ─────────────────────────────────────────────
// 기기별 플래시 시 변경할 값
#define SETUP_CODE           "A1B2C3"        // 6자리 설정 코드 (기기별 고유값)

#define SETUP_WIFI_TIMEOUT_MS   20000          // WiFi 연결 대기 타임아웃 (20s)
#define SETUP_CRED_TIMEOUT_MS   (3 * 60 * 1000) // 자격증명 대기 (3분)
#define SETUP_MAX_RETRIES       3
#define SETUP_ADV_TIMEOUT_MS    (5 * 60 * 1000) // 미연결 시 advertise 중단까지 대기 (5분)

// Setup service UUIDs (fixed, used for initial provisioning)
#define SETUP_SERVICE_UUID "26e9d5e3-cf2d-42fd-90df-8b0cc3082984"
#define SETUP_WRITE_UUID   "d5beaffe-d09e-45a0-a54a-66a0add69b68"
#define SETUP_READ_UUID    "66b21c2d-75ed-4eb2-83ee-dd71e524438d"

// ── BLE ───────────────────────────────────────────────────────────────────────
#define BLE_DEVICE_NAME "DoorLock"

// Dynamic BLE UUID defaults (runtime values live in device_config_t g_cfg)
#define BLE_SVC_UUID_DEFAULT      ""
#define BLE_CHR_READ_DEFAULT      ""
#define BLE_CHR_WRITE_DEFAULT     ""
#define MANUFACTURER_UUID_DEFAULT ""

// ── API Server ───────────────────────────────────────────────────────────────
#define API_BASE_URL          "https://your-server.example.com"
#define HA_INIT_URL           API_BASE_URL "/iot/init"
#define HA_VALIDATE_URL       API_BASE_URL "/iot/validate_token"
#define HA_PING_URL           API_BASE_URL "/iot/ping"
#define HA_VALIDATE_SETUP_URL API_BASE_URL "/iot/validate_setup"
#define HA_RESET_URL          API_BASE_URL "/iot/reset"
#define HTTP_TIMEOUT_MS 10000

// ── Ping intervals ───────────────────────────────────────────────────────────
#define PING_INTERVAL_MS       (5 * 60 * 1000)   // 5분 (정상)
#define PING_RETRY_INTERVAL_MS (30 * 1000)        // 30초 (500 또는 오류)

// ── Factory reset ─────────────────────────────────────────────────────────────
#define BOOT_BTN_GPIO        9
#define BOOT_RESET_HOLD_MS   5000

// ── GPIO ─────────────────────────────────────────────────────────────────────
#define LED_GPIO   8   // WS2812 onboard LED (GPIO8 on ESP32-C6 DevKitC-1)
#define SERVO_GPIO 2   // Servo motor PWM pin

// ── LEDC (Servo) ─────────────────────────────────────────────────────────────
#define SERVO_LEDC_TIMER      LEDC_TIMER_0
#define SERVO_LEDC_CHANNEL    LEDC_CHANNEL_0
#define SERVO_LEDC_RESOLUTION LEDC_TIMER_16_BIT
#define SERVO_FREQ_HZ         50
// Pulse width range in microseconds (standard servo: 500–2500 μs)
#define SERVO_MIN_US 500
#define SERVO_MAX_US 2500
// Defaults matching ESPHome YAML values (-1.0 to 1.0)
#define SERVO_LOW_DEFAULT   (1.0f)   // 180°
#define SERVO_HIGH_DEFAULT (-0.78f)  // 20°


// Delay before sending OTP notification after BLE connect (ms)
#define BLE_NOTIFY_DELAY_MS  3000
// Auth timeout: OTP is discarded after this many ms with no response
#define AUTH_TIMEOUT_MS      8000

// ── NVS namespaces / keys ────────────────────────────────────────────────────
#define NVS_NS_SERVO        "servo"
#define NVS_KEY_SRV_LOW     "low"
#define NVS_KEY_SRV_HIGH    "high"
#define NVS_NS_BLE          "ble"
#define NVS_KEY_RSSI_THR    "rssi_thr"
#define RSSI_DEFAULT        (-80)

// device_config NVS keys (namespace "dev_cfg")
#define NVS_KEY_SETUP_DONE  "setup_done"
#define NVS_KEY_WIFI_SSID   "wifi_ssid"
#define NVS_KEY_WIFI_PW     "wifi_pw"
