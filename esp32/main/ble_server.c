#include "ble_server.h"
#include "app_config.h"
#include "device_config.h"
#include "http_api.h"
#include "led_indicator.h"

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
#include "esp_wifi.h"
#include "esp_event.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/event_groups.h"
#include "psa/crypto.h"
#include "cJSON.h"
#include <inttypes.h>
#include <string.h>
#include <stdio.h>
#include <stdbool.h>
#include <ctype.h>

static const char *TAG = "ble";

// ── State ─────────────────────────────────────────────────────────────────────
static uint16_t s_conn_handle  = BLE_HS_CONN_HANDLE_NONE;
static uint16_t s_notify_handle;               // value handle for char_esp_to_app
static char     s_current_otp[7] = "";         // 6-hex-char OTP + NUL

static esp_timer_handle_t s_auth_timer = NULL;
static esp_timer_handle_t s_subscribe_timer = NULL;
static bool s_adv_enabled  = false;            // normal mode: init 완료 후 true
static bool s_ble_synced   = false;            // NimBLE 호스트 sync 완료 여부
static bool s_setup_mode   = false;            // setup 모드 여부
static bool s_encrypted    = false;            // 현재 연결 암호화 여부

// ── UUID storage (populated at runtime from g_cfg) ────────────────────────────
static ble_uuid128_t s_svc_uuid;
static ble_uuid128_t s_chr_read_uuid;
static ble_uuid128_t s_chr_write_uuid;

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

// Setup WiFi
static EventGroupHandle_t s_setup_wifi_eg = NULL;
#define SETUP_WIFI_OK_BIT    BIT0
#define SETUP_WIFI_FAIL_BIT  BIT1
static bool s_setup_wifi_driver_init = false;

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
    esp_timer_start_once(s_auth_timer, (uint64_t)AUTH_TIMEOUT_MS * 1000);
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

static void process_write_payload(const char *msg, uint16_t len)
{
    auth_timer_stop();

    // Payload format: "<ciphertext>" (hex, IV + data). user_uuid는 보내지 않는다.
    size_t cipher_len = len;
    if (cipher_len < 64 || cipher_len % 32 != 0) {
        ESP_LOGE(TAG, "Ciphertext length invalid (%zu)", cipher_len);
        return;
    }

    if (cipher_len >= 2048) {
        ESP_LOGE(TAG, "Ciphertext too long (%zu)", cipher_len);
        return;
    }

    ESP_LOGI(TAG, "Format OK (%zu bytes)", cipher_len);

    char nonce[7];
    strlcpy(nonce, s_current_otp, sizeof(nonce));
    s_current_otp[0] = '\0';

    // buf is heap-allocated and null-terminated, so msg is safe to pass directly
    http_request_validate_token(msg, nonce);
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

// ── OTP 발급: 앱이 notify를 구독한 뒤에만 호출된다 ───────────────────────────
static void issue_otp(uint16_t conn_handle)
{
    uint32_t rnd = esp_random() & 0x00FFFFFF;
    snprintf(s_current_otp, sizeof(s_current_otp), "%06" PRIx32, rnd);
    ESP_LOGI(TAG, "OTP issued: %s", s_current_otp);

    auth_timer_start();

    struct os_mbuf *om = ble_hs_mbuf_from_flat(s_current_otp, 6);
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
            if (s_adv_enabled) ble_advertise();
            break;

        case BLE_GAP_EVENT_SUBSCRIBE:
            if (event->subscribe.attr_handle == s_notify_handle &&
                event->subscribe.cur_notify) {
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

static void on_ble_sync(void)
{
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

// ── Public init ───────────────────────────────────────────────────────────────
void ble_server_init(void)
{
    if (!parse_uuid128(g_cfg.ble_svc_uuid,      &s_svc_uuid)   ||
        !parse_uuid128(g_cfg.ble_chr_read_uuid,  &s_chr_read_uuid) ||
        !parse_uuid128(g_cfg.ble_chr_write_uuid, &s_chr_write_uuid)) {
        ESP_LOGE(TAG, "Invalid BLE UUID in config – using defaults");
        parse_uuid128(BLE_SVC_UUID_DEFAULT,  &s_svc_uuid);
        parse_uuid128(BLE_CHR_READ_DEFAULT,  &s_chr_read_uuid);
        parse_uuid128(BLE_CHR_WRITE_DEFAULT, &s_chr_write_uuid);
    }

    ESP_ERROR_CHECK(nimble_port_init());

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

// ── Setup WiFi helper ─────────────────────────────────────────────────────────
static uint8_t s_setup_wifi_reason = 0;   // 마지막 STA_DISCONNECTED 사유

static void setup_wifi_event_handler(void *arg, esp_event_base_t base,
                                      int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *ev = (wifi_event_sta_disconnected_t *)data;
        if (ev) s_setup_wifi_reason = ev->reason;
        xEventGroupSetBits(s_setup_wifi_eg, SETUP_WIFI_FAIL_BIT);
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_setup_wifi_eg, SETUP_WIFI_OK_BIT);
    }
}

// disconnect 사유를 앱이 안내 문구로 쓸 수 있는 코드로 매핑.
// NO_AP: SSID를 못 찾음 — 5GHz 전용 AP거나 범위 밖 (ESP32-C6는 2.4GHz만 지원)
// AUTH:  AP는 찾았으나 인증 실패 — 비밀번호 오류가 대부분
static const char *setup_wifi_fail_code(void)
{
    switch (s_setup_wifi_reason) {
        case WIFI_REASON_NO_AP_FOUND:
            return "WIFI_FAIL:NO_AP";
        case WIFI_REASON_AUTH_EXPIRE:
        case WIFI_REASON_AUTH_FAIL:
        case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
        case WIFI_REASON_HANDSHAKE_TIMEOUT:
            return "WIFI_FAIL:AUTH";
        default:
            return "WIFI_FAIL";
    }
}

// Returns true if WiFi connected and IP obtained within SETUP_WIFI_TIMEOUT_MS.
// esp_netif_init() and esp_event_loop_create_default() must already be called.
static bool setup_wifi_connect(const char *ssid, const char *pw)
{
    if (!s_setup_wifi_driver_init) {
        s_setup_wifi_eg = xEventGroupCreate();
        esp_netif_create_default_wifi_sta();
        wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
        ESP_ERROR_CHECK(esp_wifi_init(&cfg));
        ESP_ERROR_CHECK(esp_event_handler_register(
            WIFI_EVENT, ESP_EVENT_ANY_ID, setup_wifi_event_handler, NULL));
        ESP_ERROR_CHECK(esp_event_handler_register(
            IP_EVENT, IP_EVENT_STA_GOT_IP, setup_wifi_event_handler, NULL));
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        s_setup_wifi_driver_init = true;
    } else {
        esp_wifi_disconnect();
        esp_wifi_stop();
    }

    wifi_config_t wifi_cfg = {0};
    strlcpy((char *)wifi_cfg.sta.ssid,     ssid, sizeof(wifi_cfg.sta.ssid));
    strlcpy((char *)wifi_cfg.sta.password, pw,   sizeof(wifi_cfg.sta.password));
    wifi_cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    s_setup_wifi_reason = 0;
    xEventGroupClearBits(s_setup_wifi_eg, SETUP_WIFI_OK_BIT | SETUP_WIFI_FAIL_BIT);
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());
    esp_wifi_connect();

    EventBits_t bits = xEventGroupWaitBits(
        s_setup_wifi_eg,
        SETUP_WIFI_OK_BIT | SETUP_WIFI_FAIL_BIT,
        pdFALSE, pdFALSE,
        pdMS_TO_TICKS(SETUP_WIFI_TIMEOUT_MS));

    return (bits & SETUP_WIFI_OK_BIT) != 0;
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
    ESP_LOGI(TAG, "Setup: setup_code = [%s]", SETUP_CODE);

    // Step 4: wait for sha256(setup_code + nonce) from app
    if (xQueueReceive(s_setup_queue, &msg, pdMS_TO_TICKS(SETUP_CRED_TIMEOUT_MS)) != pdTRUE) {
        ESP_LOGW(TAG, "Setup: SHA256 timeout");
        goto disconnect;
    }

    // Step 4: validate sha256(setup_code_lower + nonce)
    char expected[65];
    compute_sha256_hex(SETUP_CODE, nonce, expected);
    ESP_LOGI(TAG, "Setup: received  = [%s]", msg.data);
    ESP_LOGI(TAG, "Setup: expected  = [%s]", expected);
    if (strncmp(msg.data, expected, 64) != 0) {
        ESP_LOGW(TAG, "Setup: SHA256 mismatch");
        goto disconnect;
    }
    ESP_LOGI(TAG, "Setup: SHA256 valid");

    // Step 5: send device_uuid to app
    ESP_LOGI(TAG, "Setup: sending device_uuid = [%s] (%d bytes)",
             IOT_DEVICE_UUID, (int)strlen(IOT_DEVICE_UUID));
    setup_notify(IOT_DEVICE_UUID);

    // Steps 6–9: credential receive + WiFi + server validation loop
    int retry_count = 0;
    TickType_t cred_wait = pdMS_TO_TICKS(SETUP_CRED_TIMEOUT_MS);

    while (retry_count < SETUP_MAX_RETRIES) {
        // Step 6: wait for {"setup_token":"...","ssid":"...","pw":"..."}
        if (xQueueReceive(s_setup_queue, &msg, cred_wait) != pdTRUE) {
            ESP_LOGW(TAG, "Setup: credentials timeout");
            goto disconnect;
        }

        cJSON *root = cJSON_Parse(msg.data);
        if (!root) {
            ESP_LOGE(TAG, "Setup: invalid JSON credentials");
            goto disconnect;
        }
        cJSON *jtok  = cJSON_GetObjectItemCaseSensitive(root, "setup_token");
        cJSON *jssid = cJSON_GetObjectItemCaseSensitive(root, "wifi_ssid");
        cJSON *jpw   = cJSON_GetObjectItemCaseSensitive(root, "wifi_pw");

        if (!cJSON_IsString(jtok) || !cJSON_IsString(jssid) ||
            !cJSON_IsString(jpw)) {
            cJSON_Delete(root);
            ESP_LOGE(TAG, "Setup: missing JSON fields");
            goto disconnect;
        }

        char setup_token[256], wifi_ssid[CFG_SSID_LEN], wifi_pw[CFG_PW_LEN];
        strlcpy(setup_token, jtok->valuestring,  sizeof(setup_token));
        strlcpy(wifi_ssid,   jssid->valuestring, sizeof(wifi_ssid));
        strlcpy(wifi_pw,     jpw->valuestring,   sizeof(wifi_pw));
        cJSON_Delete(root);

        // Step 7: ACK receipt
        setup_notify("ACK");

        // Step 8: try WiFi
        ESP_LOGI(TAG, "Setup: connecting WiFi \"%s\"", wifi_ssid);
        if (!setup_wifi_connect(wifi_ssid, wifi_pw)) {
            retry_count++;
            const char *fail_code = setup_wifi_fail_code();
            ESP_LOGW(TAG, "Setup: WiFi failed (reason %d, %s) (retry %d/%d)",
                     s_setup_wifi_reason, fail_code, retry_count, SETUP_MAX_RETRIES);
            setup_notify(fail_code);
            cred_wait = pdMS_TO_TICKS(SETUP_CRED_TIMEOUT_MS);
            continue;
        }
        ESP_LOGI(TAG, "Setup: WiFi connected");

        // Step 8: validate setup_token with server (retry on 5xx)
        int status = 0;
        for (int srv_try = 0; srv_try < SETUP_MAX_RETRIES; srv_try++) {
            status = http_validate_setup(setup_token);
            if (status == 200 || (status >= 400 && status < 500)) break;
            ESP_LOGW(TAG, "Setup: server error %d – retry %d", status, srv_try + 1);
            vTaskDelay(pdMS_TO_TICKS(2000));
        }

        if (status == 200) {
            // Step 9: send REGISTERED
            setup_notify("REGISTERED");
            vTaskDelay(pdMS_TO_TICKS(500));  // give notification time to deliver
            // Step 10: save to NVS and reboot (never returns)
            device_config_set_setup_complete(wifi_ssid, wifi_pw);
        }

        // Token rejected by server
        retry_count++;
        ESP_LOGW(TAG, "Setup: token invalid (HTTP %d), retry %d/%d",
                 status, retry_count, SETUP_MAX_RETRIES);
        setup_notify("TOKEN_FAIL");
        cred_wait = pdMS_TO_TICKS(SETUP_CRED_TIMEOUT_MS);
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

    ble_hs_cfg.sm_io_cap         = BLE_SM_IO_CAP_NO_IO;
    ble_hs_cfg.sm_bonding        = 1;
    ble_hs_cfg.sm_mitm           = 0;
    ble_hs_cfg.sm_sc             = 1;
    ble_hs_cfg.sm_our_key_dist   = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;
    ble_hs_cfg.sm_their_key_dist = BLE_SM_PAIR_KEY_DIST_ENC | BLE_SM_PAIR_KEY_DIST_ID;

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
