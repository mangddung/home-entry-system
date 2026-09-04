#include "http_api.h"
#include "app_config.h"
#include "device_config.h"
#include "ble_server.h"
#include "servo_motor.h"
#include "led_indicator.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "cJSON.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static const char *TAG = "http";

static volatile bool s_init_ok      = false;
static volatile bool s_init_running = false;

// ── HTTP response accumulator ─────────────────────────────────────────────────
typedef struct {
    char *buf;
    int   size;
    int   len;
} resp_buf_t;

static esp_err_t http_event_cb(esp_http_client_event_t *evt)
{
    resp_buf_t *rb = (resp_buf_t *)evt->user_data;
    if (!rb || evt->event_id != HTTP_EVENT_ON_DATA) return ESP_OK;
    int copy = evt->data_len;
    if (rb->len + copy >= rb->size) copy = rb->size - rb->len - 1;
    if (copy > 0) {
        memcpy(rb->buf + rb->len, evt->data, copy);
        rb->len += copy;
        rb->buf[rb->len] = '\0';
    }
    return ESP_OK;
}

// ── Shared HTTP POST helpers ───────────────────────────────────────────────────
static int do_post(const char *url, const char *body)
{
    esp_http_client_config_t cfg = {
        .url                   = url,
        .method                = HTTP_METHOD_POST,
        .timeout_ms            = HTTP_TIMEOUT_MS,
        .disable_auto_redirect = true,
        .crt_bundle_attach     = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "User-Agent",   "esphome/doorl-device");
    esp_http_client_set_post_field(client, body, (int)strlen(body));

    esp_err_t err = esp_http_client_perform(client);
    int status = 0;
    if (err == ESP_OK) status = esp_http_client_get_status_code(client);
    else ESP_LOGE(TAG, "HTTP error: %s", esp_err_to_name(err));
    esp_http_client_cleanup(client);
    return status;
}

static int do_post_with_body(const char *url, const char *body,
                              char *resp, int resp_size)
{
    resp_buf_t rb = { .buf = resp, .size = resp_size, .len = 0 };
    if (resp && resp_size > 0) resp[0] = '\0';

    esp_http_client_config_t cfg = {
        .url                   = url,
        .method                = HTTP_METHOD_POST,
        .timeout_ms            = HTTP_TIMEOUT_MS,
        .disable_auto_redirect = true,
        .event_handler         = http_event_cb,
        .user_data             = &rb,
        .crt_bundle_attach     = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "User-Agent",   "esphome/doorl-device");
    esp_http_client_set_post_field(client, body, (int)strlen(body));

    esp_err_t err = esp_http_client_perform(client);
    int status = 0;
    if (err == ESP_OK) status = esp_http_client_get_status_code(client);
    else ESP_LOGE(TAG, "HTTP error: %s", esp_err_to_name(err));
    esp_http_client_cleanup(client);
    return status;
}

// ── Parse /api/iot/init response and apply config changes ────────────────────
// Expected response fields (all optional):
//   "device_token"     → update token (no reboot)
//   "ble_service_uuid" + "ble_read_uuid" + "ble_write_uuid" + "manufacturer_uuid"
//                      → update BLE UUIDs and reboot
static void apply_init_response(const char *json)
{
    cJSON *root = cJSON_Parse(json);
    if (!root) return;

    // Token update (no reboot)
    cJSON *token = cJSON_GetObjectItemCaseSensitive(root, "device_token");
    if (cJSON_IsString(token) && token->valuestring[0] != '\0' &&
        strcmp(token->valuestring, g_cfg.device_token) != 0) {
        device_config_set_token(token->valuestring);
    }

    // Refresh token update (defensive – /iot/init doesn't currently reissue tokens)
    cJSON *refresh = cJSON_GetObjectItemCaseSensitive(root, "refresh_token");
    if (cJSON_IsString(refresh) && refresh->valuestring[0] != '\0' &&
        strcmp(refresh->valuestring, g_cfg.refresh_token) != 0) {
        device_config_set_refresh_token(refresh->valuestring);
    }

    // BLE UUID update (reboot) — only if all 4 fields are present
    cJSON *svc  = cJSON_GetObjectItemCaseSensitive(root, "ble_service_uuid");
    cJSON *read = cJSON_GetObjectItemCaseSensitive(root, "ble_read_uuid");
    cJSON *wrt  = cJSON_GetObjectItemCaseSensitive(root, "ble_write_uuid");
    cJSON *mfr  = cJSON_GetObjectItemCaseSensitive(root, "manufacturer_uuid");

    if (cJSON_IsString(svc)  && cJSON_IsString(read) &&
        cJSON_IsString(wrt)  && cJSON_IsString(mfr)) {
        bool changed = strcmp(svc->valuestring,  g_cfg.ble_svc_uuid)       != 0 ||
                       strcmp(read->valuestring, g_cfg.ble_chr_read_uuid)   != 0 ||
                       strcmp(wrt->valuestring,  g_cfg.ble_chr_write_uuid)  != 0 ||
                       strcmp(mfr->valuestring,  g_cfg.manufacturer_uuid)   != 0;
        if (changed) {
            cJSON_Delete(root);
            device_config_update_ble(svc->valuestring, read->valuestring,
                                     wrt->valuestring, mfr->valuestring);
            return; // unreachable – esp_restart() called inside
        }
    }

    cJSON_Delete(root);
}

// ── Reauthentication fallback chain ────────────────────────────────────────────
// Parses {"data":{"access_token":..., "refresh_token":...}} and applies both.
static bool apply_auth_response(const char *json)
{
    cJSON *root = cJSON_Parse(json);
    if (!root) return false;

    cJSON *data    = cJSON_GetObjectItemCaseSensitive(root, "data");
    cJSON *access  = data ? cJSON_GetObjectItemCaseSensitive(data, "access_token")  : NULL;
    cJSON *refresh = data ? cJSON_GetObjectItemCaseSensitive(data, "refresh_token") : NULL;

    bool ok = cJSON_IsString(access) && access->valuestring[0] != '\0' &&
              cJSON_IsString(refresh) && refresh->valuestring[0] != '\0';
    if (ok) {
        device_config_set_token(access->valuestring);
        device_config_set_refresh_token(refresh->valuestring);
    }

    cJSON_Delete(root);
    return ok;
}

// On 401: try stored refresh_token via /iot/refresh, then fall back to
// device_uuid + secret_key via /iot/reauth. Updates g_cfg + NVS on success.
static bool device_reauthenticate(void)
{
    char resp_body[512];

    if (g_cfg.refresh_token[0] != '\0') {
        char body[CFG_REFRESH_LEN + 32];
        snprintf(body, sizeof(body), "{\"refresh_token\":\"%s\"}", g_cfg.refresh_token);
        int status = do_post_with_body(HA_REFRESH_URL, body, resp_body, sizeof(resp_body));
        if (status == 200 && apply_auth_response(resp_body)) {
            ESP_LOGI(TAG, "reauth: /iot/refresh succeeded");
            return true;
        }
        ESP_LOGW(TAG, "reauth: /iot/refresh failed (HTTP %d)", status);
    }

    char body[256];
    snprintf(body, sizeof(body), "{\"device_uuid\":\"%s\",\"secret_key\":\"%s\"}",
             IOT_DEVICE_UUID, IOT_DEVICE_SECRET_KEY);
    int status = do_post_with_body(HA_REAUTH_URL, body, resp_body, sizeof(resp_body));
    if (status == 200 && apply_auth_response(resp_body)) {
        ESP_LOGI(TAG, "reauth: /iot/reauth succeeded");
        return true;
    }
    ESP_LOGW(TAG, "reauth: /iot/reauth failed (HTTP %d)", status);
    return false;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

static void task_iot_init(void *arg)
{
    char auth_header[CFG_TOKEN_LEN + 8];  // "Bearer " + token
    snprintf(auth_header, sizeof(auth_header), "Bearer %s", g_cfg.device_token);

    char body[512];
    snprintf(body, sizeof(body),
        "{\"device_uuid\":\"%s\","
        "\"ble_service_uuid\":\"%s\","
        "\"ble_read_uuid\":\"%s\","
        "\"ble_write_uuid\":\"%s\","
        "\"manufacturer_uuid\":\"%s\"}",
        IOT_DEVICE_UUID,
        g_cfg.ble_svc_uuid,
        g_cfg.ble_chr_read_uuid,
        g_cfg.ble_chr_write_uuid,
        g_cfg.manufacturer_uuid);

    char resp_body[512] = {0};
    int status = 0;

    for (int attempt = 0; attempt < 2; attempt++) {
        resp_body[0] = '\0';
        resp_buf_t rb = { .buf = resp_body, .size = sizeof(resp_body), .len = 0 };

        esp_http_client_config_t cfg = {
            .url                   = HA_INIT_URL,
            .method                = HTTP_METHOD_POST,
            .timeout_ms            = HTTP_TIMEOUT_MS,
            .disable_auto_redirect = true,
            .event_handler         = http_event_cb,
            .user_data             = &rb,
            .buffer_size_tx        = CFG_TOKEN_LEN + 256,
            .crt_bundle_attach     = esp_crt_bundle_attach,
        };
        esp_http_client_handle_t client = esp_http_client_init(&cfg);
        esp_http_client_set_header(client, "Content-Type",  "application/json");
        esp_http_client_set_header(client, "User-Agent",    "esphome/doorl-device");
        esp_http_client_set_header(client, "Authorization", auth_header);
        esp_http_client_set_post_field(client, body, (int)strlen(body));

        esp_err_t err = esp_http_client_perform(client);
        status = 0;
        if (err == ESP_OK) status = esp_http_client_get_status_code(client);
        else ESP_LOGE(TAG, "HTTP error: %s", esp_err_to_name(err));
        esp_http_client_cleanup(client);

        if (status == 401 && attempt == 0 && device_reauthenticate()) {
            ESP_LOGI(TAG, "IoT init: retrying after reauth");
            snprintf(auth_header, sizeof(auth_header), "Bearer %s", g_cfg.device_token);
            continue;
        }
        break;
    }

    char *resp = resp_body;
    switch (status) {
        case 200:
            ESP_LOGI(TAG, "IoT init OK");
            s_init_ok = true;
            led_init_ok();
            ble_advertising_start();
            apply_init_response(resp);
            break;
        case 400:
            ESP_LOGW(TAG, "IoT init bad request (400)");
            led_init_fail();
            break;
        case 401:
            ESP_LOGW(TAG, "IoT init unauthorized (401)");
            led_init_fail();
            break;
        case 0:
            ESP_LOGE(TAG, "IoT init request failed (network / unreachable)");
            led_init_fail();
            break;
        default:
            ESP_LOGW(TAG, "IoT init HTTP %d", status);
            led_init_fail();
            break;
    }
    s_init_running = false;
    vTaskDelete(NULL);
}

typedef struct {
    char user_uuid[64];
    char encrypted_token[2048];
    char nonce[16];
} validate_args_t;

static void task_validate_token(void *arg)
{
    validate_args_t *a = (validate_args_t *)arg;

    const size_t body_size = 2200;
    char *body = malloc(body_size);
    if (!body) {
        ESP_LOGE(TAG, "OOM for validate body");
        free(a);
        vTaskDelete(NULL);
        return;
    }

    int n = snprintf(body, body_size,
        "{\"user_uuid\":\"%s\","
        "\"encrypted_token\":\"%s\","
        "\"nonce\":\"%s\"}",
        a->user_uuid, a->encrypted_token, a->nonce);
    free(a);

    if (n < 0 || (size_t)n >= body_size) {
        ESP_LOGE(TAG, "validate body truncated – aborting");
        free(body);
        vTaskDelete(NULL);
        return;
    }

    char auth_header[CFG_TOKEN_LEN + 8];
    int status = 0;

    for (int attempt = 0; attempt < 2; attempt++) {
        snprintf(auth_header, sizeof(auth_header), "Bearer %s", g_cfg.device_token);

        esp_http_client_config_t cfg = {
            .url                   = HA_VALIDATE_URL,
            .method                = HTTP_METHOD_POST,
            .timeout_ms            = HTTP_TIMEOUT_MS,
            .disable_auto_redirect = true,
            .buffer_size_tx        = CFG_TOKEN_LEN + 256,
            .crt_bundle_attach     = esp_crt_bundle_attach,
        };
        esp_http_client_handle_t client = esp_http_client_init(&cfg);
        esp_http_client_set_header(client, "Content-Type",  "application/json");
        esp_http_client_set_header(client, "User-Agent",    "esphome/doorl-device");
        esp_http_client_set_header(client, "Authorization", auth_header);
        esp_http_client_set_post_field(client, body, (int)strlen(body));

        esp_err_t err = esp_http_client_perform(client);
        status = 0;
        if (err == ESP_OK) status = esp_http_client_get_status_code(client);
        else ESP_LOGE(TAG, "HTTP error: %s", esp_err_to_name(err));
        esp_http_client_cleanup(client);

        if (status == 401 && attempt == 0 && device_reauthenticate()) {
            ESP_LOGI(TAG, "Token validation: retrying after reauth");
            continue;
        }
        break;
    }
    free(body);

    switch (status) {
        case 200:
            ESP_LOGI(TAG, "Token validation OK");
            led_notify_success();
            servo_activate();
            ble_server_disconnect();
            break;
        case 400:
            ESP_LOGW(TAG, "Token validation bad request (400)");
            led_notify_fail();
            break;
        case 401:
            ESP_LOGW(TAG, "Token validation unauthorized (401)");
            led_notify_fail();
            break;
        case 0:
            ESP_LOGE(TAG, "Token validation request failed (network / unreachable)");
            led_notify_fail();
            break;
        default:
            ESP_LOGW(TAG, "Token validation HTTP %d", status);
            led_notify_fail();
            break;
    }
    vTaskDelete(NULL);
}

static void task_ping(void *arg)
{
    for (;;) {
        char auth_header[CFG_TOKEN_LEN + 8];
        int status = 0;

        for (int attempt = 0; attempt < 2; attempt++) {
            snprintf(auth_header, sizeof(auth_header), "Bearer %s", g_cfg.device_token);

            esp_http_client_config_t cfg = {
                .url                   = HA_PING_URL,
                .method                = HTTP_METHOD_POST,
                .timeout_ms            = HTTP_TIMEOUT_MS,
                .disable_auto_redirect = true,
                .buffer_size_tx        = CFG_TOKEN_LEN + 256,
                .crt_bundle_attach     = esp_crt_bundle_attach,
            };
            esp_http_client_handle_t client = esp_http_client_init(&cfg);
            esp_http_client_set_header(client, "Content-Type",  "application/json");
            esp_http_client_set_header(client, "User-Agent",    "esphome/doorl-device");
            esp_http_client_set_header(client, "Authorization", auth_header);
            esp_http_client_set_post_field(client, "{}", 2);

            esp_err_t err = esp_http_client_perform(client);
            status = 0;
            if (err == ESP_OK) status = esp_http_client_get_status_code(client);
            else ESP_LOGE(TAG, "Ping failed: %s", esp_err_to_name(err));
            esp_http_client_cleanup(client);

            if (status == 401 && attempt == 0 && device_reauthenticate()) {
                ESP_LOGI(TAG, "Ping: retrying after reauth");
                continue;
            }
            break;
        }

        TickType_t delay_ms;
        if (status == 200) {
            ESP_LOGI(TAG, "Ping OK – next in 5 min");
            if (!s_init_ok && !s_init_running) {
                ESP_LOGI(TAG, "Init not done – retrying iot_init");
                http_fetch_iot_init();
            }
            delay_ms = PING_INTERVAL_MS;
        } else {
            if (status == 500)
                ESP_LOGW(TAG, "Ping 500 – retry in 30s");
            else
                ESP_LOGW(TAG, "Ping HTTP %d – retry in 30s", status);
            delay_ms = PING_RETRY_INTERVAL_MS;
        }

        vTaskDelay(pdMS_TO_TICKS(delay_ms));
    }
}

void http_notify_reset(void)
{
    char auth_header[CFG_TOKEN_LEN + 8];
    snprintf(auth_header, sizeof(auth_header), "Bearer %s", g_cfg.device_token);

    char body[128];
    snprintf(body, sizeof(body), "{\"device_uuid\":\"%s\"}", IOT_DEVICE_UUID);

    for (int i = 0; i < 2; i++) {
        if (i > 0) vTaskDelay(pdMS_TO_TICKS(2000));

        esp_http_client_config_t cfg = {
            .url                   = HA_RESET_URL,
            .method                = HTTP_METHOD_POST,
            .timeout_ms            = HTTP_TIMEOUT_MS,
            .disable_auto_redirect = true,
            .buffer_size_tx        = CFG_TOKEN_LEN + 256,
            .crt_bundle_attach     = esp_crt_bundle_attach,
        };
        esp_http_client_handle_t client = esp_http_client_init(&cfg);
        esp_http_client_set_header(client, "Content-Type",  "application/json");
        esp_http_client_set_header(client, "User-Agent",    "esphome/doorl-device");
        esp_http_client_set_header(client, "Authorization", auth_header);
        esp_http_client_set_post_field(client, body, (int)strlen(body));

        esp_err_t err = esp_http_client_perform(client);
        int status = 0;
        if (err == ESP_OK) status = esp_http_client_get_status_code(client);
        else ESP_LOGE(TAG, "reset attempt %d failed: %s", i + 1, esp_err_to_name(err));
        esp_http_client_cleanup(client);
        ESP_LOGI(TAG, "reset HTTP %d (attempt %d/2)", status, i + 1);

        if (status == 200) break;  // 성공 시 바로 반환
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

void http_fetch_iot_init(void)
{
    s_init_running = true;
    xTaskCreate(task_iot_init, "http_init", 6144, NULL, 5, NULL);
}

void http_request_validate_token(const char *user_uuid,
                                  const char *encrypted_token,
                                  const char *nonce)
{
    validate_args_t *a = malloc(sizeof(validate_args_t));
    if (!a) {
        ESP_LOGE(TAG, "OOM for validate_args");
        return;
    }
    strlcpy(a->user_uuid,       user_uuid,       sizeof(a->user_uuid));
    strlcpy(a->encrypted_token, encrypted_token, sizeof(a->encrypted_token));
    strlcpy(a->nonce,           nonce,           sizeof(a->nonce));
    xTaskCreate(task_validate_token, "http_val", 5120, a, 5, NULL);
}

void http_start_ping_task(void)
{
    xTaskCreate(task_ping, "http_ping", 4096, NULL, 4, NULL);
}

int http_validate_setup(const char *setup_token, const char *user_uuid)
{
    char body[512];
    int n = snprintf(body, sizeof(body),
                     "{\"setup_token\":\"%s\",\"user_uuid\":\"%s\",\"secret_key\":\"%s\"}",
                     setup_token, user_uuid, IOT_DEVICE_SECRET_KEY);
    if (n < 0 || (size_t)n >= sizeof(body)) {
        ESP_LOGE(TAG, "validate_setup body truncated");
        return 0;
    }

    char resp_body[640] = {0};
    resp_buf_t rb = { .buf = resp_body, .size = sizeof(resp_body), .len = 0 };

    char auth_header[CFG_TOKEN_LEN + 8];
    snprintf(auth_header, sizeof(auth_header), "Bearer %s", g_cfg.device_token);

    esp_http_client_config_t cfg = {
        .url                   = HA_VALIDATE_SETUP_URL,
        .method                = HTTP_METHOD_POST,
        .timeout_ms            = HTTP_TIMEOUT_MS,
        .disable_auto_redirect = true,
        .event_handler         = http_event_cb,
        .user_data             = &rb,
        .buffer_size_tx        = CFG_TOKEN_LEN + 256,
        .crt_bundle_attach     = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type",  "application/json");
    esp_http_client_set_header(client, "User-Agent",    "esphome/doorl-device");
    esp_http_client_set_header(client, "Authorization", auth_header);
    esp_http_client_set_post_field(client, body, (int)strlen(body));

    esp_err_t err = esp_http_client_perform(client);
    int status = 0;
    if (err == ESP_OK) status = esp_http_client_get_status_code(client);
    else ESP_LOGE(TAG, "validate_setup request failed: %s", esp_err_to_name(err));
    esp_http_client_cleanup(client);

    if (status == 200) {
        cJSON *root = cJSON_Parse(resp_body);
        if (root) {
            cJSON *data  = cJSON_GetObjectItemCaseSensitive(root, "data");
            cJSON *token = data ? cJSON_GetObjectItemCaseSensitive(data, "device_token") : NULL;
            if (cJSON_IsString(token) && token->valuestring[0] != '\0')
                device_config_set_token(token->valuestring);
            cJSON_Delete(root);
        }
    }

    ESP_LOGI(TAG, "validate_setup HTTP %d", status);
    return status;
}
