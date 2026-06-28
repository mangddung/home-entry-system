#include "device_config.h"
#include "ble_server.h"
#include "app_config.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_system.h"
#include "esp_log.h"
#include "mbedtls/base64.h"
#include "cJSON.h"
#include <string.h>
#include <stdlib.h>
#include <stdbool.h>

static const char *TAG = "cfg";
#define NVS_NS "dev_cfg"

device_config_t g_cfg;

// ── JWT payload decoder ───────────────────────────────────────────────────────

// Decodes the JWT payload (middle part) into out. Returns true on success.
static bool decode_jwt_payload(const char *token, char *out, size_t out_size)
{
    const char *p1 = strchr(token, '.');
    if (!p1) return false;
    const char *p2 = strchr(p1 + 1, '.');
    if (!p2) return false;

    size_t enc_len = (size_t)(p2 - (p1 + 1));
    if (enc_len == 0 || enc_len >= out_size) return false;

    // base64url → base64: replace - with +, _ with /
    char *b64 = malloc(enc_len + 4);
    if (!b64) return false;
    memcpy(b64, p1 + 1, enc_len);
    for (size_t i = 0; i < enc_len; i++) {
        if (b64[i] == '-') b64[i] = '+';
        else if (b64[i] == '_') b64[i] = '/';
    }
    // Add = padding
    size_t pad = (4 - enc_len % 4) % 4;
    for (size_t i = 0; i < pad; i++) b64[enc_len + i] = '=';
    size_t total = enc_len + pad;

    size_t out_len = 0;
    int ret = mbedtls_base64_decode((unsigned char *)out, out_size - 1,
                                    &out_len,
                                    (unsigned char *)b64, total);
    free(b64);
    if (ret != 0) return false;
    out[out_len] = '\0';
    return true;
}

// Extract BLE UUIDs from JWT payload JSON. Returns true if all 4 found.
static bool load_ble_from_token(const char *token)
{
    char payload[1024];
    if (!decode_jwt_payload(token, payload, sizeof(payload))) {
        ESP_LOGW(TAG, "JWT payload decode failed");
        return false;
    }

    cJSON *root = cJSON_Parse(payload);
    if (!root) {
        ESP_LOGW(TAG, "JWT payload JSON parse failed");
        return false;
    }

    cJSON *svc  = cJSON_GetObjectItemCaseSensitive(root, "ble_service_uuid");
    cJSON *read = cJSON_GetObjectItemCaseSensitive(root, "ble_read_uuid");
    cJSON *wrt  = cJSON_GetObjectItemCaseSensitive(root, "ble_write_uuid");
    cJSON *mfr  = cJSON_GetObjectItemCaseSensitive(root, "manufacturer_uuid");

    bool ok = cJSON_IsString(svc)  && cJSON_IsString(read) &&
              cJSON_IsString(wrt)  && cJSON_IsString(mfr);
    if (ok) {
        strlcpy(g_cfg.ble_svc_uuid,       svc->valuestring,  sizeof(g_cfg.ble_svc_uuid));
        strlcpy(g_cfg.ble_chr_read_uuid,  read->valuestring, sizeof(g_cfg.ble_chr_read_uuid));
        strlcpy(g_cfg.ble_chr_write_uuid, wrt->valuestring,  sizeof(g_cfg.ble_chr_write_uuid));
        strlcpy(g_cfg.manufacturer_uuid,  mfr->valuestring,  sizeof(g_cfg.manufacturer_uuid));
        ESP_LOGI(TAG, "BLE UUIDs loaded from JWT payload");
    } else {
        ESP_LOGW(TAG, "JWT payload missing BLE UUID fields");
    }

    cJSON_Delete(root);
    return ok;
}

// ── NVS helper ────────────────────────────────────────────────────────────────

static void load_str(nvs_handle_t h, const char *key,
                     char *dst, size_t len, const char *fallback)
{
    size_t sz = len;
    if (nvs_get_str(h, key, dst, &sz) != ESP_OK)
        strlcpy(dst, fallback, len);
}

// ── Public API ────────────────────────────────────────────────────────────────

void device_config_load(void)
{
    nvs_handle_t h;
    bool has_nvs = (nvs_open(NVS_NS, NVS_READONLY, &h) == ESP_OK);

    // Token: NVS → DEFAULT
    if (has_nvs) {
        load_str(h, "token", g_cfg.device_token,
                 sizeof(g_cfg.device_token), IOT_DEVICE_TOKEN_DEFAULT);
    } else {
        strlcpy(g_cfg.device_token, IOT_DEVICE_TOKEN_DEFAULT,
                sizeof(g_cfg.device_token));
    }

    // Setup done flag
    uint8_t done = 0;
    if (has_nvs) nvs_get_u8(h, NVS_KEY_SETUP_DONE, &done);
    g_cfg.setup_done = (done != 0);

    // WiFi credentials (only meaningful after setup)
    if (has_nvs) {
        load_str(h, NVS_KEY_WIFI_SSID, g_cfg.wifi_ssid,
                 sizeof(g_cfg.wifi_ssid), "");
        load_str(h, NVS_KEY_WIFI_PW,   g_cfg.wifi_password,
                 sizeof(g_cfg.wifi_password), "");
    }

    if (has_nvs) nvs_close(h);

    // BLE UUIDs: JWT payload → NVS → hardcoded defaults
    if (!load_ble_from_token(g_cfg.device_token)) {
        bool ble_from_nvs = false;
        nvs_handle_t bh;
        if (nvs_open(NVS_NS, NVS_READONLY, &bh) == ESP_OK) {
            size_t sz = sizeof(g_cfg.ble_svc_uuid);
            ble_from_nvs = (nvs_get_str(bh, "ble_svc", g_cfg.ble_svc_uuid, &sz) == ESP_OK);
            if (ble_from_nvs) {
                load_str(bh, "ble_read",  g_cfg.ble_chr_read_uuid,  sizeof(g_cfg.ble_chr_read_uuid),  BLE_CHR_READ_DEFAULT);
                load_str(bh, "ble_write", g_cfg.ble_chr_write_uuid, sizeof(g_cfg.ble_chr_write_uuid), BLE_CHR_WRITE_DEFAULT);
                load_str(bh, "mfr_uuid",  g_cfg.manufacturer_uuid,  sizeof(g_cfg.manufacturer_uuid),  MANUFACTURER_UUID_DEFAULT);
            }
            nvs_close(bh);
        }
        if (!ble_from_nvs) {
            strlcpy(g_cfg.ble_svc_uuid,       BLE_SVC_UUID_DEFAULT,      sizeof(g_cfg.ble_svc_uuid));
            strlcpy(g_cfg.ble_chr_read_uuid,  BLE_CHR_READ_DEFAULT,       sizeof(g_cfg.ble_chr_read_uuid));
            strlcpy(g_cfg.ble_chr_write_uuid, BLE_CHR_WRITE_DEFAULT,      sizeof(g_cfg.ble_chr_write_uuid));
            strlcpy(g_cfg.manufacturer_uuid,  MANUFACTURER_UUID_DEFAULT,  sizeof(g_cfg.manufacturer_uuid));
        }
    }

    ESP_LOGI(TAG, "loaded: svc=%s", g_cfg.ble_svc_uuid);
}

void device_config_set_token(const char *token)
{
    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NVS_NS, NVS_READWRITE, &h));
    nvs_set_str(h, "token", token);
    nvs_commit(h);
    nvs_close(h);
    strlcpy(g_cfg.device_token, token, sizeof(g_cfg.device_token));
    ESP_LOGI(TAG, "device token updated");
}

void device_config_update_ble(const char *svc, const char *read,
                               const char *write, const char *mfr)
{
    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NVS_NS, NVS_READWRITE, &h));
    nvs_set_str(h, "ble_svc",   svc);
    nvs_set_str(h, "ble_read",  read);
    nvs_set_str(h, "ble_write", write);
    nvs_set_str(h, "mfr_uuid",  mfr);
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "BLE UUIDs updated – rebooting");
    esp_restart();
}

void device_config_set_setup_complete(const char *ssid, const char *pw)
{
    strlcpy(g_cfg.wifi_ssid,     ssid, sizeof(g_cfg.wifi_ssid));
    strlcpy(g_cfg.wifi_password, pw,   sizeof(g_cfg.wifi_password));
    g_cfg.setup_done = true;

    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NVS_NS, NVS_READWRITE, &h));
    nvs_set_str(h, NVS_KEY_WIFI_SSID,  ssid);
    nvs_set_str(h, NVS_KEY_WIFI_PW,    pw);
    nvs_set_u8(h,  NVS_KEY_SETUP_DONE, 1);
    nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "Setup complete – rebooting");
    esp_restart();
}

void device_config_factory_reset(void)
{
    nvs_handle_t h;
    if (nvs_open(NVS_NS, NVS_READWRITE, &h) == ESP_OK) {
        nvs_erase_key(h, NVS_KEY_SETUP_DONE);
        nvs_erase_key(h, NVS_KEY_WIFI_SSID);
        nvs_erase_key(h, NVS_KEY_WIFI_PW);
        nvs_commit(h);
        nvs_close(h);
    }
    ble_server_clear_bonds();
    ESP_LOGI(TAG, "Factory reset – rebooting");
    esp_restart();
}
