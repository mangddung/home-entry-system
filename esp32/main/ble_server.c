#include "ble_server.h"
#include "app_config.h"
#include "device_config.h"
#include "transport.h"
#include "led_indicator.h"
#include "servo_motor.h"

#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "esp_random.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "psa/crypto.h"
#include <inttypes.h>
#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#include <ctype.h>

static const char *TAG = "ble";

// ── State ─────────────────────────────────────────────────────────────────────
static uint16_t s_conn_handle  = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_notify_handle;               // value handle for char_esp_to_app
static char     s_current_otp[17] = "";        // 16-hex-char OTP(64bit) + NUL
static bool     s_otp_issued = false;          // 연결당 OTP 1회만 발급(재구독으로 nonce 재추첨 방지)

static esp_timer_handle_t s_auth_timer = NULL;
static esp_timer_handle_t s_subscribe_timer = NULL;
static bool s_adv_enabled  = false;            // normal mode: init 완료 후 true
static bool s_ble_synced   = false;            // NimBLE 호스트 sync 완료 여부
static bool s_setup_mode   = false;            // setup 모드 여부
static bool s_encrypted    = false;            // 현재 연결 암호화 여부

// 서보 실시간 조절·재본딩. 본딩은 연결 암호화만 맡고 권한이 아니다: 연결마다 서버 서명을 받아야 열린다.
static volatile bool     s_live_granted = false;   // SRVS 검증됨: 서보 특성 쓰기 허용
static bool              s_live_moved   = false;   // 이 연결에서 움직였으면 끊길 때 대기 위치로 돌아간다
static volatile bool     s_bond_window  = false;   // SRVB 검증됨: 이 연결에서 새 본딩 허용
static volatile uint32_t s_conn_gen     = 0;       // 연결마다 증가. 검증 중 연결이 바뀐 명령을 버린다
static uint32_t          s_auth_timeout_ms = AUTH_TIMEOUT_MS;
#define SERVO_LIVE_IDLE_MS (2 * 60 * 1000)         // 조작이 없으면 끊는다. 연결 중엔 광고가 멈춰 다른 사람이 못 연다
#define BOND_WINDOW_MS     (30 * 1000)             // 앱 lib/ble.ts BOND_RESULT_TIMEOUT_MS와 같은 값
// 서보 실시간 조절 특성. 서비스 UUID가 기기마다 달라 특성 UUID는 고정이다 (app/lib/ble.ts와 짝).
#define SERVO_LIVE_CHR_UUID "a3f1c6e2-5b7d-4e19-8c42-7d9e0b36f1a8"

void ble_store_config_init(void);  // NimBLE가 헤더로 노출하지 않는다

// ── UUID storage (populated at runtime from g_cfg) ────────────────────────────
static ble_uuid128_t s_svc_uuid;
static ble_uuid128_t s_chr_read_uuid;
static ble_uuid128_t s_chr_write_uuid;
static ble_uuid128_t s_chr_live_uuid;

// ── Setup mode state ──────────────────────────────────────────────────────────
typedef struct {
    char data[512];
} setup_msg_t;

static QueueHandle_t    s_setup_queue = NULL;
static TaskHandle_t     s_setup_task  = NULL;
static ble_uuid128_t    s_setup_svc_uuid;
static ble_uuid128_t    s_setup_read_uuid;
static ble_uuid128_t    s_setup_write_uuid;
static uint16_t         s_setup_notify_handle;
static esp_timer_handle_t s_setup_timeout_timer = NULL;
static bool              s_setup_timed_out = false;  // SETUP_ADV_TIMEOUT_MS 동안 미연결

// Parse "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" into NimBLE little-endian layout
static bool parse_uuid128(const char *str, ble_uuid128_t *out)
{
    uint8_t buf[16];
    int idx = 0;
    const char *p = str;
    while (*p && idx < 16) {
        if (*p == '-') { p++; continue; }
        if (!*(p + 1)) return false;
        char hex[3] = {p[0], p[1], 0};
        buf[idx++] = (uint8_t)strtol(hex, NULL, 16);
        p += 2;
    }
    if (idx != 16) return false;
    out->u.type = BLE_UUID_TYPE_128;
    for (int k = 0; k < 16; k++) out->value[k] = buf[15 - k];
    return true;
}

// ── Forward declarations ───────────────────────────────────────────────────────
static void ble_advertise(void);
static void issue_otp(uint16_t conn_handle);
#define SUBSCRIBE_TIMEOUT_MS 10000   // 연결 후 notify 구독까지 허용 시간

static int  gap_event_handler(struct ble_gap_event *event, void *arg);

// ── Auth timeout ──────────────────────────────────────────────────────────────
static void auth_timeout_cb(void *arg)
{
    if (s_current_otp[0] != '\0') {
        ESP_LOGW(TAG, "Auth timeout – OTP discarded");
        s_current_otp[0] = '\0';
    }
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
    }
}

static void auth_timer_start(void)
{
    if (s_auth_timer == NULL) {
        esp_timer_create_args_t args = {
            .callback = auth_timeout_cb,
            .name     = "auth_tmr",
        };
        ESP_ERROR_CHECK(esp_timer_create(&args, &s_auth_timer));
    }
    esp_timer_stop(s_auth_timer);
    esp_timer_start_once(s_auth_timer, (uint64_t)s_auth_timeout_ms * 1000);
}

static void auth_timer_stop(void)
{
    if (s_auth_timer) esp_timer_stop(s_auth_timer);
}

// ── Subscribe watchdog ────────────────────────────────────────────────────────
// notify 구독 없이 붙어 있는 연결(Android 설정 화면 등)은 OTP를 받을 자격이 없다.
// 정해진 시간 안에 구독하지 않으면 연결을 끊는다.
static void subscribe_timeout_cb(void *arg)
{
    ESP_LOGW(TAG, "No notify subscription – dropping connection");
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
    }
}

static void subscribe_timer_start(void)
{
    if (s_subscribe_timer == NULL) {
        esp_timer_create_args_t args = {
            .callback = subscribe_timeout_cb,
            .name     = "sub_tmr",
        };
        ESP_ERROR_CHECK(esp_timer_create(&args, &s_subscribe_timer));
    }
    esp_timer_stop(s_subscribe_timer);
    esp_timer_start_once(s_subscribe_timer, (uint64_t)SUBSCRIBE_TIMEOUT_MS * 1000);
}

static void subscribe_timer_stop(void)
{
    if (s_subscribe_timer) esp_timer_stop(s_subscribe_timer);
}

// ── GATT characteristic callbacks ─────────────────────────────────────────────

static int chr_notify_access(uint16_t conn_handle, uint16_t attr_handle,
                              struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        // App reads current OTP
        os_mbuf_append(ctxt->om, s_current_otp, strlen(s_current_otp));
    }
    return 0;
}

static bool is_hex(const char *s, uint16_t len)
{
    for (uint16_t i = 0; i < len; i++) {
        if (!isxdigit((unsigned char)s[i])) return false;
    }
    return true;
}

// ── 서보 범위 명령 ────────────────────────────────────────────────────────────
// BLE 연결·페어링은 마스터 증명이 아니다. 서버가 마스터를 확인하고 기기 비밀키로 서명한 명령만 적용한다.
//   "SRV?"                        → "SRV:<동작각>:<대기각>" (조회, 서명 불필요)
//   "SRV:<동작각>:<대기각>:<mac>" → "SRV_OK" / "SRV_FAIL"
//     mac = HMAC-SHA256(기기 비밀키, "servo|<nonce>|<동작각>|<대기각>") hex
//   "SRVS:<mac>" → "SRVS_OK" / "SRV_FAIL". 실시간 조절 허가, mac 입력 "ble-live|<nonce>"
//   "SRVB:<mac>" → "SRVB_OK" / "SRV_FAIL". 재본딩 허가, mac 입력 "ble-bond|<nonce>". 끝나면 "BOND_OK" / "BOND_FAIL"
// (서명은 server/app/routes/client/devices.py와 짝). nonce는 명령 하나에만 쓰고, 조절 중에는 다음 명령용으로 새로 발급한다.
#define SERVO_DEG_MAX 180

typedef enum { SERVO_CMD_RANGE, SERVO_CMD_LIVE, SERVO_CMD_BOND } servo_cmd_kind_t;

typedef struct {
    servo_cmd_kind_t kind;
    uint32_t conn_gen;
    int  low_deg;
    int  high_deg;
    char mac[65];
    char nonce[sizeof(s_current_otp)];
    bool valid;
    struct ble_npl_event ev;  // 검증 결과를 NimBLE 호스트 태스크로 넘긴다
} servo_cmd_t;

static void ble_notify_str(const char *msg)
{
    struct os_mbuf *om = ble_hs_mbuf_from_flat(msg, strlen(msg));
    if (om) ble_gatts_notify_custom(s_conn_handle, s_notify_handle, om);
}

static bool hex_to_bin(const char *hex, uint8_t *out, size_t out_len)
{
    if (strlen(hex) != out_len * 2 || !is_hex(hex, out_len * 2)) return false;
    for (size_t i = 0; i < out_len; i++) {
        char byte[3] = {hex[i * 2], hex[i * 2 + 1], 0};
        out[i] = (uint8_t)strtol(byte, NULL, 16);
    }
    return true;
}

static bool servo_mac_valid(const char *input, const char *mac_hex)
{
    uint8_t secret[16], mac[32];
    if (!hex_to_bin(IOT_DEVICE_SECRET_KEY, secret, sizeof(secret)) ||
        !hex_to_bin(mac_hex, mac, sizeof(mac))) {
        return false;
    }
    psa_crypto_init();
    psa_key_attributes_t attr = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&attr, PSA_KEY_TYPE_HMAC);
    psa_set_key_bits(&attr, 128);
    psa_set_key_usage_flags(&attr, PSA_KEY_USAGE_VERIFY_MESSAGE);
    psa_set_key_algorithm(&attr, PSA_ALG_HMAC(PSA_ALG_SHA_256));
    psa_key_id_t key;
    if (psa_import_key(&attr, secret, sizeof(secret), &key) != PSA_SUCCESS) return false;
    bool ok = psa_mac_verify(key, PSA_ALG_HMAC(PSA_ALG_SHA_256),
                             (const uint8_t *)input, strlen(input), mac, sizeof(mac)) == PSA_SUCCESS;
    psa_destroy_key(key);
    return ok;
}

// 검증 결과 반영. NimBLE 호스트 태스크에서 실행되어 GAP 연결·끊김 처리와 겹치지 않는다
// (다른 태스크에서 연결 확인과 허가를 따로 하면 그 사이 끊김·재연결에 허가가 다음 연결로 넘어간다).
static void servo_cmd_result(struct ble_npl_event *ev)
{
    servo_cmd_t *c = ble_npl_event_get_arg(ev);
    if (c->conn_gen != s_conn_gen) {
        // 검증하는 동안 연결이 끊겼다. 허가가 다음 연결로 넘어가지 않게 버린다.
        ESP_LOGW(TAG, "Servo command dropped: connection changed");
    } else if (!c->valid) {
        ESP_LOGW(TAG, "Servo command rejected");
        ble_notify_str("SRV_FAIL");
        if (s_live_granted) issue_otp(s_conn_handle);
    } else if (c->kind == SERVO_CMD_RANGE) {
        ble_notify_str("SRV_OK");
        s_live_moved = false;
        if (s_live_granted) issue_otp(s_conn_handle);
    } else if (c->kind == SERVO_CMD_LIVE) {
        ESP_LOGI(TAG, "Servo live session granted");
        s_auth_timeout_ms = SERVO_LIVE_IDLE_MS;
        s_live_granted = true;
        ble_notify_str("SRVS_OK");
        issue_otp(s_conn_handle);
    } else {
        ESP_LOGI(TAG, "Rebond window opened");
        s_auth_timeout_ms = BOND_WINDOW_MS;
        auth_timer_start();
        ble_hs_cfg.sm_bonding = 1;
        s_bond_window = true;
        ble_notify_str("SRVB_OK");
    }
    ble_npl_event_deinit(ev);  // init이 이벤트 메모리를 따로 잡는다
    free(c);
}

// PSA 검증과 NVS 쓰기를 NimBLE 호스트 태스크 밖에서 처리하고, 결과 반영은 호스트 태스크로 넘긴다
static void servo_cmd_task(void *arg)
{
    servo_cmd_t *c = arg;
    char input[48];
    if (c->kind == SERVO_CMD_RANGE) {
        snprintf(input, sizeof(input), "servo|%s|%d|%d", c->nonce, c->low_deg, c->high_deg);
    } else {
        snprintf(input, sizeof(input), "%s|%s", c->kind == SERVO_CMD_LIVE ? "ble-live" : "ble-bond", c->nonce);
    }
    c->valid = servo_mac_valid(input, c->mac);

    // 범위 저장은 서버가 서명한 값이라 연결이 바뀌어도 넘어가는 권한이 없다. 응답만 호스트 태스크가 보낸다.
    if (c->valid && c->kind == SERVO_CMD_RANGE && c->conn_gen == s_conn_gen) {
        servo_set_range_deg(c->low_deg, c->high_deg);
        ESP_LOGI(TAG, "Servo range saved: %d / %d", c->low_deg, c->high_deg);
        servo_activate();  // 새 범위를 바로 눈으로 확인하게 한 번 움직인다. 끝나면 대기 위치다.
    }
    ble_npl_event_init(&c->ev, servo_cmd_result, c);
    ble_npl_eventq_put(nimble_port_get_dflt_eventq(), &c->ev);
    vTaskDelete(NULL);
}

// 재본딩 마무리. 실패해도 창을 닫아 다시 허가받게 한다.
// 다른 폰의 본딩은 지우지 않는다. 본딩만으로는 권한이 없고, 지우면 그 폰은 암호화에 실패해 문도 못 연다.
static void finish_rebond(uint16_t conn_handle, int status)
{
    s_bond_window = false;
    ble_hs_cfg.sm_bonding = 0;

    struct ble_gap_conn_desc desc;
    if (status != 0 || ble_gap_conn_find(conn_handle, &desc) != 0 || !desc.sec_state.bonded) {
        ESP_LOGW(TAG, "Rebond failed (status=%d)", status);
        ble_notify_str("BOND_FAIL");
        return;
    }
    ESP_LOGI(TAG, "Rebond complete");
    ble_notify_str("BOND_OK");
}

static void process_servo_command(const char *msg)
{
    if (strcmp(msg, "SRV?") == 0) {
        int low_deg, high_deg;
        char reply[32];
        servo_get_range_deg(&low_deg, &high_deg);
        snprintf(reply, sizeof(reply), "SRV:%d:%d", low_deg, high_deg);
        ble_notify_str(reply);
        return;
    }

    servo_cmd_t *c = calloc(1, sizeof(*c));
    if (!c) {
        ble_notify_str("SRV_FAIL");
        return;
    }
    bool parsed;
    if (strncmp(msg, "SRVS:", 5) == 0 || strncmp(msg, "SRVB:", 5) == 0) {
        c->kind = msg[3] == 'S' ? SERVO_CMD_LIVE : SERVO_CMD_BOND;
        parsed = sscanf(msg + 5, "%64s", c->mac) == 1;
    } else {
        c->kind = SERVO_CMD_RANGE;
        parsed = sscanf(msg, "SRV:%d:%d:%64s", &c->low_deg, &c->high_deg, c->mac) == 3 &&
                 c->low_deg >= 0 && c->low_deg <= SERVO_DEG_MAX &&
                 c->high_deg >= 0 && c->high_deg <= SERVO_DEG_MAX;
    }
    if (!parsed) {
        ESP_LOGE(TAG, "Servo command format invalid");
        free(c);
        ble_notify_str("SRV_FAIL");
        return;
    }
    c->conn_gen = s_conn_gen;
    // nonce는 명령 하나에만 쓴다. 틀린 mac을 같은 연결에서 반복 시도하지 못하고, 인증 타이머가 연결을 정리한다.
    strlcpy(c->nonce, s_current_otp, sizeof(c->nonce));
    s_current_otp[0] = '\0';
    if (xTaskCreate(servo_cmd_task, "servo_cmd", 4096, c, 5, NULL) != pdPASS) {
        free(c);
        ble_notify_str("SRV_FAIL");
    }
}

static void process_write_payload(const char *msg, uint16_t len)
{
    // OTP가 없으면(구독 전·소진·만료) 서버로 보내지 않는다. 인증 없이 쓸 수 있는 특성이라
    // 막지 않으면 쓰기 폭주가 HTTP 태스크와 서버 요청 제한을 소모한다.
    if (s_current_otp[0] == '\0') {
        ESP_LOGW(TAG, "Write without valid OTP – ignored");
        return;
    }

    if (strncmp(msg, "SRV", 3) == 0) {
        process_servo_command(msg);
        return;
    }

    // Payload format: "<mac>" (hex 64자, HMAC-SHA256(user key, nonce + auth_token)). user_uuid는 보내지 않는다.
    if (len != 64 || !is_hex(msg, len)) {
        ESP_LOGE(TAG, "MAC format invalid (%u bytes)", len);
        return;
    }

    auth_timer_stop();
    ESP_LOGI(TAG, "Format OK (%u bytes)", len);

    char nonce[sizeof(s_current_otp)];
    strlcpy(nonce, s_current_otp, sizeof(nonce));
    s_current_otp[0] = '\0';

    // buf is heap-allocated and null-terminated, so msg is safe to pass directly
    transport_validate_token(msg, nonce);
}

static int chr_write_access(uint16_t conn_handle, uint16_t attr_handle,
                             struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return 0;

    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    if (len >= 2100) {
        ESP_LOGE(TAG, "Write too large (%u bytes) – ignored", len);
        return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;
    }
    char *buf = malloc(len + 1);
    if (!buf) {
        ESP_LOGE(TAG, "OOM for write buffer");
        return BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    ble_hs_mbuf_to_flat(ctxt->om, buf, len, NULL);
    buf[len] = '\0';
    ESP_LOGI(TAG, "Received (%u bytes)", len);
    process_write_payload(buf, len);
    free(buf);
    return 0;
}

// 서보 실시간 조절. 반응 속도를 위해 호스트 태스크에서 바로 처리한다(NVS·PSA 없음).
static int chr_live_access(uint16_t conn_handle, uint16_t attr_handle,
                            struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    // 읽기는 앱이 암호화를 시작시키는 용도다. 응답이 갔다면 암호화가 끝난 것이다.
    if (ctxt->op == BLE_GATT_ACCESS_OP_READ_CHR) {
        static const uint8_t ready = 1;
        return os_mbuf_append(ctxt->om, &ready, sizeof(ready)) == 0 ? 0 : BLE_ATT_ERR_INSUFFICIENT_RES;
    }
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return 0;

    // 일반 모드는 아무 폰이나 Just Works로 암호화할 수 있으므로 암호화만으로는 부족하다.
    struct ble_gap_conn_desc desc;
    uint8_t deg;
    if (!s_live_granted || OS_MBUF_PKTLEN(ctxt->om) != sizeof(deg) ||
        ble_gap_conn_find(conn_handle, &desc) != 0 ||
        !desc.sec_state.encrypted || !desc.sec_state.bonded) {
        return BLE_ATT_ERR_WRITE_NOT_PERMITTED;
    }
    ble_hs_mbuf_to_flat(ctxt->om, &deg, sizeof(deg), NULL);
    if (deg > SERVO_DEG_MAX) return BLE_ATT_ERR_WRITE_NOT_PERMITTED;

    s_live_moved = true;
    servo_preview_deg(deg);
    auth_timer_start();
    return 0;
}

// ── GATT service table ────────────────────────────────────────────────────────
static const struct ble_gatt_svc_def s_gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                // char_esp_to_app: read | notify
                .uuid       = &s_chr_read_uuid.u,
                .access_cb  = chr_notify_access,
                .val_handle = &s_notify_handle,
                .flags      = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_NOTIFY,
            },
            {
                // char_app_to_esp: write (with response)
                .uuid      = &s_chr_write_uuid.u,
                .access_cb = chr_write_access,
                .flags     = BLE_GATT_CHR_F_WRITE,
            },
            {
                // char_servo_live: 읽기 = 암호화 시작, 쓰기 = 각도 1바이트(0~180).
                // 표 맨 뒤에 둔다. 본딩한 폰이 캐시한 기존 특성의 핸들이 바뀌면 문 열기가 깨진다.
                .uuid      = &s_chr_live_uuid.u,
                .access_cb = chr_live_access,
                .flags     = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC |
                             BLE_GATT_CHR_F_WRITE_NO_RSP | BLE_GATT_CHR_F_WRITE_ENC,
            },
            { 0 }, // terminator
        },
    },
    { 0 }, // terminator
};

// ── Device name ───────────────────────────────────────────────────────────────
// "doorl-" + device_uuid 앞 8자. 31바이트 광고 페이로드에 128bit UUID와 함께
// 넣을 수 없어 이름은 scan response로 보낸다.
static char s_dev_name[16];

static void build_dev_name(void)
{
    if (IOT_DEVICE_UUID[0] != 0) {
        snprintf(s_dev_name, sizeof(s_dev_name), BLE_DEVICE_NAME_PREFIX "%.8s", IOT_DEVICE_UUID);
    } else {
        // 아직 uuid가 없는 기기(미플래시/셋업 전)는 MAC 뒤 3바이트로 구분한다.
        uint8_t mac[6] = {0};
        esp_read_mac(mac, ESP_MAC_BT);
        snprintf(s_dev_name, sizeof(s_dev_name), BLE_DEVICE_NAME_PREFIX "%02x%02x%02x",
                 mac[3], mac[4], mac[5]);
    }
}

static void adv_set_name_rsp(void)
{
    struct ble_hs_adv_fields rsp = {
        .name             = (const uint8_t *)s_dev_name,
        .name_len         = strlen(s_dev_name),
        .name_is_complete = 1,
    };
    ble_gap_adv_rsp_set_fields(&rsp);
}

// 광고 manufacturer data: company ID(little-endian) + 모델 코드(transport.h).
// 앱 스캔 목록이 연결 전에 Wi-Fi/Zigbee 아이콘을 고른다. 광고 31바이트 중 26바이트 사용.
// ponytail: Espressif company ID(0x02E5)를 빌려 쓴다. 자체 Bluetooth SIG ID를 받으면 교체(앱 lib/ble.ts도 함께).
static const uint8_t s_adv_mfg_data[] = { 0xE5, 0x02, TRANSPORT_MODEL_CODE };

// ── Advertising ───────────────────────────────────────────────────────────────
// 쉬는 구간 없이 고정 간격으로 계속 광고한다. 앱의 근접 해제(RSSI 중앙값 판정)가
// 고른 샘플을 받아야 해제 지연이 들쭉날쭉하지 않다. 예전 방식(30~60ms 광고 + 3초 휴식)과
// 초당 광고 횟수가 비슷해 전력도 비슷한 수준으로 본다.
// TODO(실측): 소비 전류와 앱 샘플 수신율을 재고 간격 조정. 간격·TX 출력을 바꾸면 RSSI 보정값을 다시 재야 한다.
#define ADV_ITVL_MS  100

static void ble_advertise(void)
{
    struct ble_gap_adv_params params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
        .itvl_min  = BLE_GAP_ADV_ITVL_MS(ADV_ITVL_MS),
        .itvl_max  = BLE_GAP_ADV_ITVL_MS(ADV_ITVL_MS),
    };
    struct ble_hs_adv_fields fields = {
        .flags              = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP,
        .uuids128           = &s_svc_uuid,
        .num_uuids128       = 1,
        .uuids128_is_complete = 1,
        .mfg_data           = s_adv_mfg_data,
        .mfg_data_len       = sizeof(s_adv_mfg_data),
    };
    ble_gap_adv_set_fields(&fields);
    adv_set_name_rsp();
    ble_gap_adv_start(BLE_OWN_ADDR_RANDOM, NULL, BLE_HS_FOREVER,
                      &params, gap_event_handler, NULL);
    ESP_LOGI(TAG, "BLE advertising (%dms interval) svc=%s read=%s write=%s mfr=%s",
             ADV_ITVL_MS, g_cfg.ble_svc_uuid, g_cfg.ble_chr_read_uuid,
             g_cfg.ble_chr_write_uuid, g_cfg.manufacturer_uuid);
}

void ble_advertising_start(void)
{
    s_adv_enabled = true;
    // iot/init이 BLE sync보다 먼저 끝날 수 있다. 스택 준비 전에 광고하면
    // NimBLE 내부 NULL 참조로 죽으므로, sync 콜백에서 대신 시작한다.
    if (s_ble_synced) ble_advertise();
    else ESP_LOGI(TAG, "init OK – waiting for BLE stack sync to advertise");
}

void ble_server_disconnect(void)
{
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE)
        ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
}

void ble_server_clear_bonds(void)
{
    ble_store_clear();
}

#define AUTH_RESULT_FLUSH_MS 300  // 끊기 전에 notify가 전송될 시간

void ble_server_auth_result(const char *code)
{
    ble_notify_str(code);
    if (strcmp(code, "AUTH_OK") == 0) {
        vTaskDelay(pdMS_TO_TICKS(AUTH_RESULT_FLUSH_MS));
        ble_server_disconnect();
    } else {
        // 실패는 앱이 받고 끊는다. 앱이 응답 없이 사라져도 연결이 남지 않게 인증 타이머를 다시 건다.
        auth_timer_start();
    }
}

// ── OTP 발급: 앱이 notify를 구독한 뒤에만 호출된다 ───────────────────────────
static void issue_otp(uint16_t conn_handle)
{
    s_otp_issued = true;
    snprintf(s_current_otp, sizeof(s_current_otp), "%08" PRIx32 "%08" PRIx32,
             esp_random(), esp_random());
    ESP_LOGI(TAG, "OTP issued");

    auth_timer_start();

    // 16바이트: 기본 MTU(payload 20바이트) 안에 들어간다
    struct os_mbuf *om = ble_hs_mbuf_from_flat(s_current_otp, sizeof(s_current_otp) - 1);
    if (om) {
        ble_gatts_notify_custom(conn_handle, s_notify_handle, om);
    }
}

// ── GAP event handler ─────────────────────────────────────────────────────────
static int gap_event_handler(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                ESP_LOGI(TAG, "App connected (handle %d)", event->connect.conn_handle);
                s_conn_handle = event->connect.conn_handle;
                s_otp_issued  = false;
                s_conn_gen++;
                {
                    // 저장된 구독을 지운다. 남아 있으면 본딩한 폰이 암호화되는 순간 구독이 복원되어, 앱이 듣기 전에
                    // nonce가 나가 사라진다. 앱의 구독 요청은 값이 같아 이벤트도 안 오므로 문을 못 열게 된다.
                    union ble_store_key key = {0};
                    ble_store_util_delete_all(BLE_STORE_OBJ_TYPE_CCCD, &key);
                }
                subscribe_timer_start();
            } else {
                ble_advertise();
            }
            break;

        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGI(TAG, "App disconnected (reason %d)", event->disconnect.reason);
            subscribe_timer_stop();
            auth_timer_stop();
            s_current_otp[0] = '\0';
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            s_conn_gen++;
            if (s_live_moved) servo_rest();  // 저장하지 않고 끊기면 문이 풀린 채 남지 않게 한다
            s_live_moved = false;
            s_live_granted = false;
            s_bond_window = false;
            ble_hs_cfg.sm_bonding = 0;
            s_auth_timeout_ms = AUTH_TIMEOUT_MS;
            if (s_adv_enabled) ble_advertise();
            break;

        case BLE_GAP_EVENT_ENC_CHANGE:
            // 저장된 본딩으로 암호화만 한 경우(실시간 조절)는 할 일이 없다
            if (s_bond_window) finish_rebond(event->enc_change.conn_handle, event->enc_change.status);
            break;

        case BLE_GAP_EVENT_REPEAT_PAIRING:
        {
            // 재본딩 허가가 없으면 거부한다. 폰 주소를 위조해 기존 본딩을 덮어쓰지 못하게 한다.
            if (!s_bond_window) return BLE_GAP_REPEAT_PAIRING_IGNORE;
            struct ble_gap_conn_desc desc;
            if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc) == 0) {
                ble_store_util_delete_peer(&desc.peer_id_addr);
            }
            return BLE_GAP_REPEAT_PAIRING_RETRY;
        }

        case BLE_GAP_EVENT_SUBSCRIBE:
            if (event->subscribe.attr_handle == s_notify_handle &&
                event->subscribe.cur_notify && !s_otp_issued) {
                subscribe_timer_stop();
                issue_otp(event->subscribe.conn_handle);
            }
            break;

        case BLE_GAP_EVENT_ADV_COMPLETE:
            // 무기한 광고라 연결 외 사유로 끝났을 때만 다시 시작한다
            ESP_LOGI(TAG, "BLE adv ended (reason %d)", event->adv_complete.reason);
            if (event->adv_complete.reason != 0 && s_adv_enabled &&
                s_conn_handle == BLE_HS_CONN_HANDLE_NONE)
                ble_advertise();
            break;

        default:
            break;
    }
    return 0;
}

// ── NimBLE host task ──────────────────────────────────────────────────────────
static void ble_host_task(void *param)
{
    nimble_port_run();
    nimble_port_freertos_deinit();
}

// ── Sync callback (stack ready) ───────────────────────────────────────────────
static void setup_ble_advertise(void);   // forward declaration

// 재부팅·모드 전환에도 같은 주소를 쓴다. 주소가 바뀌면 폰은 다른 기기로 보아 등록 때 맺은 본딩을 쓸 수 없다.
static void ble_set_stable_addr(void)
{
    uint8_t addr[6];
    ESP_ERROR_CHECK(esp_read_mac(addr, ESP_MAC_BT));
    addr[5] |= 0xC0;  // 최상위 2비트 = static random 주소
    int rc = ble_hs_id_set_rnd(addr);
    if (rc != 0) ESP_LOGE(TAG, "Stable address rejected (rc=%d)", rc);
}

static void on_ble_sync(void)
{
    ble_set_stable_addr();
    ble_hs_util_ensure_addr(1);
    ble_att_set_preferred_mtu(512);
    s_ble_synced = true;
    if (s_setup_mode) {
        setup_ble_advertise();
    } else if (s_adv_enabled) {
        ESP_LOGI(TAG, "BLE stack ready – init already OK, advertising now");
        ble_advertise();
    } else {
        ESP_LOGI(TAG, "BLE stack ready – waiting for init OK to start advertising");
    }
}

static void on_ble_reset(int reason)
{
    ESP_LOGW(TAG, "BLE host reset (reason %d)", reason);
}

// 페어링 규칙과 본딩 저장소. nimble_port_init() 뒤에 부른다. 페어링은 항상 앱이 시작한다.
static void ble_security_init(bool bonding)
{
    ble_hs_cfg.sm_io_cap         = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_bonding        = bonding;
    ble_hs_cfg.sm_mitm           = 0;
    ble_hs_cfg.sm_sc             = 1;
    ble_hs_cfg.sm_our_key_dist   = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.store_status_cb   = ble_store_util_status_rr;  // 저장소가 차면 오래된 본딩부터 지운다
    ble_store_config_init();
}

// ── Public init ───────────────────────────────────────────────────────────────
void ble_server_init(void)
{
    parse_uuid128(SERVO_LIVE_CHR_UUID, &s_chr_live_uuid);
    if (!parse_uuid128(g_cfg.ble_svc_uuid,      &s_svc_uuid)   ||
        !parse_uuid128(g_cfg.ble_chr_read_uuid,  &s_chr_read_uuid) ||
        !parse_uuid128(g_cfg.ble_chr_write_uuid, &s_chr_write_uuid)) {
        ESP_LOGE(TAG, "Invalid BLE UUID in config – using defaults");
        parse_uuid128(BLE_SVC_UUID_DEFAULT,  &s_svc_uuid);
        parse_uuid128(BLE_CHR_READ_DEFAULT,  &s_chr_read_uuid);
        parse_uuid128(BLE_CHR_WRITE_DEFAULT, &s_chr_write_uuid);
    }

    ESP_ERROR_CHECK(nimble_port_init());

    ble_security_init(false);  // 일반 모드는 재본딩 허가(SRVB) 중에만 새 본딩을 저장한다
    ble_hs_cfg.sync_cb  = on_ble_sync;
    ble_hs_cfg.reset_cb = on_ble_reset;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    build_dev_name();
    ESP_ERROR_CHECK(ble_svc_gap_device_name_set(s_dev_name));
    ESP_ERROR_CHECK(ble_gatts_count_cfg(s_gatt_svcs));
    ESP_ERROR_CHECK(ble_gatts_add_svcs(s_gatt_svcs));

    nimble_port_freertos_init(ble_host_task);
    ESP_LOGI(TAG, "BLE server initialized");
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETUP MODE
// ═══════════════════════════════════════════════════════════════════════════════

// ── SHA256 helper ─────────────────────────────────────────────────────────────
// 설정 코드를 소문자로 정규화한 뒤 sha256(code_lower + nonce) 계산
static void compute_sha256_hex(const char *code, const char *nonce, char out_hex[65])
{
    char code_lower[16] = {0};
    for (int i = 0; code[i] && i < (int)sizeof(code_lower) - 1; i++)
        code_lower[i] = (char)tolower((unsigned char)code[i]);

    char input[32];
    snprintf(input, sizeof(input), "%s%s", code_lower, nonce);
    uint8_t hash[32];
    size_t hash_len;
    psa_hash_compute(PSA_ALG_SHA_256, (const unsigned char *)input, strlen(input), hash, sizeof(hash), &hash_len);
    for (int i = 0; i < 32; i++)
        snprintf(out_hex + i * 2, 3, "%02x", hash[i]);
    out_hex[64] = '\0';
}

// ── Setup notify helper ───────────────────────────────────────────────────────
static void setup_notify(const char *msg)
{
    if (s_conn_handle == BLE_HS_CONN_HANDLE_NONE) return;
    struct os_mbuf *om = ble_hs_mbuf_from_flat(msg, strlen(msg));
    if (om) ble_gatts_notify_custom(s_conn_handle, s_setup_notify_handle, om);
}

// ── Setup flow task ───────────────────────────────────────────────────────────
static void setup_flow_task(void *arg)
{
    (void)arg;
    setup_msg_t msg;

    // Wait for app to subscribe before notifying
    vTaskDelay(pdMS_TO_TICKS(BLE_NOTIFY_DELAY_MS));

    // Step 3: generate and send nonce
    uint32_t rnd = esp_random() & 0x00FFFFFF;
    char nonce[7];
    snprintf(nonce, sizeof(nonce), "%06" PRIx32, rnd);
    setup_notify(nonce);
    ESP_LOGI(TAG, "Setup: nonce     = [%s]", nonce);

    // Step 4: wait for sha256(setup_code + nonce) from app
    if (xQueueReceive(s_setup_queue, &msg, pdMS_TO_TICKS(SETUP_CRED_TIMEOUT_MS)) != pdTRUE) {
        ESP_LOGW(TAG, "Setup: SHA256 timeout");
        goto disconnect;
    }

    // Step 4: validate sha256(setup_code_lower + nonce)
    char expected[65];
    compute_sha256_hex(SETUP_CODE, nonce, expected);
    if (strncmp(msg.data, expected, 64) != 0) {
        ESP_LOGW(TAG, "Setup: SHA256 mismatch");
        goto disconnect;
    }
    ESP_LOGI(TAG, "Setup: SHA256 valid");

    // Step 5: send device_uuid to app
    ESP_LOGI(TAG, "Setup: sending device_uuid = [%s] (%d bytes)",
             IOT_DEVICE_UUID, (int)strlen(IOT_DEVICE_UUID));
    setup_notify(IOT_DEVICE_UUID);

    // Steps 6–9: credential receive + network + server validation loop (모델별 transport)
    int retry_count = 0;
    while (retry_count < SETUP_MAX_RETRIES) {
        // Step 6: wait for credentials JSON (Wi-Fi: setup_token + ssid/pw, Zigbee: setup_token)
        if (xQueueReceive(s_setup_queue, &msg, pdMS_TO_TICKS(SETUP_CRED_TIMEOUT_MS)) != pdTRUE) {
            ESP_LOGW(TAG, "Setup: credentials timeout");
            goto disconnect;
        }
        // 성공하면 저장 후 재부팅되어 돌아오지 않는다
        if (!transport_setup(msg.data, setup_notify)) goto disconnect;
        retry_count++;
        ESP_LOGW(TAG, "Setup: attempt failed (retry %d/%d)", retry_count, SETUP_MAX_RETRIES);
    }

disconnect:
    ESP_LOGW(TAG, "Setup: flow ended – cleaning up");
    // 먼저 NULL로 표시해야 disconnect 이벤트에서 중복 삭제 방지
    s_setup_task = NULL;
    if (s_setup_queue) {
        setup_msg_t tmp;
        while (xQueueReceive(s_setup_queue, &tmp, 0) == pdTRUE) {}
        vQueueDelete(s_setup_queue);
        s_setup_queue = NULL;
    }
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE)
        ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
    vTaskDelete(NULL);
}

// ── Setup GATT ────────────────────────────────────────────────────────────────
static int setup_chr_notify_access(uint16_t conn_handle, uint16_t attr_handle,
                                    struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    return 0;
}

static int setup_chr_write_access(uint16_t conn_handle, uint16_t attr_handle,
                                   struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle; (void)attr_handle; (void)arg;
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return 0;

    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    if (len >= sizeof(setup_msg_t)) return BLE_ATT_ERR_INVALID_ATTR_VALUE_LEN;

    setup_msg_t msg;
    ble_hs_mbuf_to_flat(ctxt->om, msg.data, len, NULL);
    msg.data[len] = '\0';

    if (s_setup_queue) xQueueSend(s_setup_queue, &msg, 0);
    return 0;
}

static const struct ble_gatt_svc_def s_setup_gatt_svcs[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_setup_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid       = &s_setup_read_uuid.u,
                .access_cb  = setup_chr_notify_access,
                .val_handle = &s_setup_notify_handle,
                .flags      = BLE_GATT_CHR_F_READ | BLE_GATT_CHR_F_READ_ENC | BLE_GATT_CHR_F_NOTIFY,
            },
            {
                .uuid      = &s_setup_write_uuid.u,
                .access_cb = setup_chr_write_access,
                .flags     = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_ENC,
            },
            { 0 },
        },
    },
    { 0 },
};

// ── Setup advertise timeout (5분 미연결 시 절전) ────────────────────────────────
static void setup_adv_timeout_cb(void *arg)
{
    (void)arg;
    ESP_LOGW(TAG, "Setup: %dms 동안 미연결 – advertise 중단, 절전 대기", SETUP_ADV_TIMEOUT_MS);
    s_setup_timed_out = true;
    ble_gap_adv_stop();
    led_setup_timeout();
}

// ── Setup GAP event handler ───────────────────────────────────────────────────
static int setup_gap_event_handler(struct ble_gap_event *event, void *arg)
{
    switch (event->type) {
        case BLE_GAP_EVENT_CONNECT:
            if (event->connect.status == 0) {
                ESP_LOGI(TAG, "Setup: app connected (handle %d)",
                         event->connect.conn_handle);
                s_conn_handle = event->connect.conn_handle;
                s_encrypted = false;
                if (s_setup_timeout_timer) esp_timer_stop(s_setup_timeout_timer);
                led_ble_connected();
                // 앱이 READ_ENC 특성 읽기 시도 → Android이 페어링 개시 (팝업 1개)
            } else {
                setup_ble_advertise();
            }
            break;

        case BLE_GAP_EVENT_DISCONNECT:
            ESP_LOGI(TAG, "Setup: app disconnected (reason %d)",
                     event->disconnect.reason);
            s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            s_encrypted = false;
            led_idle_blink_start();
            if (s_setup_task) { vTaskDelete(s_setup_task); s_setup_task = NULL; }
            if (s_setup_queue) { vQueueDelete(s_setup_queue); s_setup_queue = NULL; }
            setup_ble_advertise();
            break;

        case BLE_GAP_EVENT_ENC_CHANGE:
            ESP_LOGI(TAG, "Setup: encryption changed (status=%d)", event->enc_change.status);
            if (event->enc_change.status == 0) {
                s_encrypted = true;
                // 키 갱신(재암호화)으로 같은 연결에서 다시 오면 진행 중인 흐름을 유지한다
                // (새로 만들면 기존 태스크·큐 핸들이 덮여 누수되고 두 태스크가 큐를 나눠 읽는다)
                if (s_setup_task) break;
                s_setup_queue = xQueueCreate(4, sizeof(setup_msg_t));
                xTaskCreate(setup_flow_task, "setup_flow", 8192,
                            NULL, 5, &s_setup_task);
            } else {
                ESP_LOGW(TAG, "Setup: encryption failed – disconnecting");
                ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
            }
            break;

        case BLE_GAP_EVENT_REPEAT_PAIRING:
        {
            struct ble_gap_conn_desc desc;
            if (ble_gap_conn_find(event->repeat_pairing.conn_handle, &desc) == 0) {
                ble_store_util_delete_peer(&desc.peer_id_addr);
            }
            return BLE_GAP_REPEAT_PAIRING_RETRY;
        }

        case BLE_GAP_EVENT_ADV_COMPLETE:
            setup_ble_advertise();
            break;

        default:
            break;
    }
    return 0;
}

// ── Setup advertising (continuous) ───────────────────────────────────────────
static void setup_ble_advertise(void)
{
    if (s_setup_timed_out) return;  // 5분 미연결 – advertise 재개 안 함

    struct ble_gap_adv_params params = {
        .conn_mode = BLE_GAP_CONN_MODE_UND,
        .disc_mode = BLE_GAP_DISC_MODE_GEN,
    };
    struct ble_hs_adv_fields fields = {
        .flags              = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP,
        .uuids128           = &s_setup_svc_uuid,
        .num_uuids128       = 1,
        .uuids128_is_complete = 1,
        .mfg_data           = s_adv_mfg_data,
        .mfg_data_len       = sizeof(s_adv_mfg_data),
    };
    ble_gap_adv_set_fields(&fields);
    adv_set_name_rsp();
    ble_gap_adv_start(BLE_OWN_ADDR_RANDOM, NULL, BLE_HS_FOREVER,
                      &params, setup_gap_event_handler, NULL);
    ESP_LOGI(TAG, "BLE setup advertising (continuous)");
}

// ── Public setup init ─────────────────────────────────────────────────────────
void ble_setup_server_init(void)
{
    s_setup_mode = true;

    parse_uuid128(SETUP_SERVICE_UUID, &s_setup_svc_uuid);
    parse_uuid128(SETUP_READ_UUID,    &s_setup_read_uuid);
    parse_uuid128(SETUP_WRITE_UUID,   &s_setup_write_uuid);

    ESP_ERROR_CHECK(nimble_port_init());

    ble_security_init(true);

    ble_hs_cfg.sync_cb  = on_ble_sync;
    ble_hs_cfg.reset_cb = on_ble_reset;

    ble_svc_gap_init();
    ble_svc_gatt_init();

    build_dev_name();
    ESP_ERROR_CHECK(ble_svc_gap_device_name_set(s_dev_name));
    ESP_ERROR_CHECK(ble_gatts_count_cfg(s_setup_gatt_svcs));
    ESP_ERROR_CHECK(ble_gatts_add_svcs(s_setup_gatt_svcs));

    nimble_port_freertos_init(ble_host_task);

    const esp_timer_create_args_t timeout_args = {
        .callback = setup_adv_timeout_cb,
        .name     = "setup_adv_timeout",
    };
    esp_timer_create(&timeout_args, &s_setup_timeout_timer);
    esp_timer_start_once(s_setup_timeout_timer, (uint64_t)SETUP_ADV_TIMEOUT_MS * 1000);

    ESP_LOGI(TAG, "BLE setup server initialized");
}
