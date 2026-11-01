// Wi-Fi 모델 transport: Wi-Fi STA 연결 + HTTP(http_api.c)로 서버 직접 통신.
#include "transport.h"
#include "app_config.h"
#include "device_config.h"
#include "led_indicator.h"
#include "http_api.h"

#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <string.h>

static const char *TAG = "wifi";

static EventGroupHandle_t s_wifi_eg;
#define WIFI_CONNECTED_BIT BIT0

static bool s_init_done    = false;
static bool s_ping_started = false;
static bool s_wifi_timeout = false;

// ── WiFi event handler ────────────────────────────────────────────────────────
static void wifi_event_handler(void *arg, esp_event_base_t base,
                               int32_t id, void *data)
{
    if (base == WIFI_EVENT) {
        if (id == WIFI_EVENT_STA_START) {
            esp_wifi_connect();
        } else if (id == WIFI_EVENT_STA_DISCONNECTED) {
            xEventGroupClearBits(s_wifi_eg, WIFI_CONNECTED_BIT);
            if (!s_wifi_timeout) {
                ESP_LOGW(TAG, "WiFi disconnected – retrying…");
                esp_wifi_connect();
            }
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *evt = (ip_event_got_ip_t *)data;
        ESP_LOGI(TAG, "Got IP: " IPSTR, IP2STR(&evt->ip_info.ip));
        xEventGroupSetBits(s_wifi_eg, WIFI_CONNECTED_BIT);

        if (!s_init_done) {
            ESP_LOGI(TAG, "WiFi connected – starting fetch_iot_init");
            http_fetch_iot_init();
            s_init_done = true;
        }
        if (!s_ping_started) {
            http_start_ping_task();
            s_ping_started = true;
        }
    }
}

// ── Normal mode WiFi init ─────────────────────────────────────────────────────
// esp_netif_init() and esp_event_loop_create_default() must be called before this.
static void wifi_init(void)
{
    s_wifi_eg = xEventGroupCreate();

    esp_netif_create_default_wifi_sta();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, wifi_event_handler, NULL, NULL));

    wifi_config_t wifi_cfg = {0};
    strlcpy((char *)wifi_cfg.sta.ssid,     g_cfg.wifi_ssid,     sizeof(wifi_cfg.sta.ssid));
    strlcpy((char *)wifi_cfg.sta.password, g_cfg.wifi_password, sizeof(wifi_cfg.sta.password));
    wifi_cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(TAG, "WiFi init done – connecting to \"%s\"", g_cfg.wifi_ssid);
}

void transport_init(void)
{
    // Always initialize netif and event loop (needed by both setup and normal WiFi)
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
}

void transport_start(void)
{
    led_wifi_connecting();
    wifi_init();

    EventBits_t bits = xEventGroupWaitBits(s_wifi_eg, WIFI_CONNECTED_BIT,
                                           pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(30000));
    if (!(bits & WIFI_CONNECTED_BIT)) {
        s_wifi_timeout = true;
        ESP_LOGE(TAG, "WiFi connection timed out after 30 s");
        led_init_fail();  // solid red
    }
}

void transport_validate_token(const char *mac_hex, const char *nonce_hex)
{
    http_request_validate_token(mac_hex, nonce_hex);
}

void transport_notify_reset(void)
{
    http_notify_reset();  // 2회 시도, 결과 무관
}

void transport_factory_reset(void)
{
    esp_restart();
}

// ── Setup WiFi helper ─────────────────────────────────────────────────────────
static EventGroupHandle_t s_setup_wifi_eg = NULL;
#define SETUP_WIFI_OK_BIT    BIT0
#define SETUP_WIFI_FAIL_BIT  BIT1
static bool s_setup_wifi_driver_init = false;
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

// Step 6: {"setup_token":"...","wifi_ssid":"...","wifi_pw":"..."}
bool transport_setup(const char *cred_json, void (*notify)(const char *msg))
{
    cJSON *root = cJSON_Parse(cred_json);
    if (!root) {
        ESP_LOGE(TAG, "Setup: invalid JSON credentials");
        return false;
    }
    cJSON *jtok  = cJSON_GetObjectItemCaseSensitive(root, "setup_token");
    cJSON *jssid = cJSON_GetObjectItemCaseSensitive(root, "wifi_ssid");
    cJSON *jpw   = cJSON_GetObjectItemCaseSensitive(root, "wifi_pw");

    if (!cJSON_IsString(jtok) || !cJSON_IsString(jssid) ||
        !cJSON_IsString(jpw)) {
        cJSON_Delete(root);
        ESP_LOGE(TAG, "Setup: missing JSON fields");
        return false;
    }

    char setup_token[256], wifi_ssid[CFG_SSID_LEN], wifi_pw[CFG_PW_LEN];
    strlcpy(setup_token, jtok->valuestring,  sizeof(setup_token));
    strlcpy(wifi_ssid,   jssid->valuestring, sizeof(wifi_ssid));
    strlcpy(wifi_pw,     jpw->valuestring,   sizeof(wifi_pw));
    cJSON_Delete(root);

    // Step 7: ACK receipt
    notify("ACK");

    // Step 8: try WiFi
    ESP_LOGI(TAG, "Setup: connecting WiFi \"%s\"", wifi_ssid);
    if (!setup_wifi_connect(wifi_ssid, wifi_pw)) {
        const char *fail_code = setup_wifi_fail_code();
        ESP_LOGW(TAG, "Setup: WiFi failed (reason %d, %s)", s_setup_wifi_reason, fail_code);
        notify(fail_code);
        return true;
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
        notify("REGISTERED");
        vTaskDelay(pdMS_TO_TICKS(500));  // give notification time to deliver
        // Step 10: save to NVS and reboot (never returns)
        device_config_set_setup_complete(wifi_ssid, wifi_pw);
    }

    // Token rejected by server
    ESP_LOGW(TAG, "Setup: token invalid (HTTP %d)", status);
    notify("TOKEN_FAIL");
    return true;
}
