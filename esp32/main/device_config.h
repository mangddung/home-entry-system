#pragma once
#include <stdbool.h>

#define CFG_UUID_LEN    37   // 36 hex chars + NUL
#define CFG_TOKEN_LEN   768  // JWT can be several hundred chars (jti/exp 추가로 573자까지 관측됨)
#define CFG_REFRESH_LEN 96   // secrets.token_urlsafe(48) ~= 64 chars + headroom
#define CFG_SSID_LEN    33   // 32 chars + NUL
#define CFG_PW_LEN      65   // 64 chars + NUL

typedef struct {
    char device_token[CFG_TOKEN_LEN];
    char refresh_token[CFG_REFRESH_LEN];
    char ble_svc_uuid[CFG_UUID_LEN];
    char ble_chr_read_uuid[CFG_UUID_LEN];
    char ble_chr_write_uuid[CFG_UUID_LEN];
    char manufacturer_uuid[CFG_UUID_LEN];
    char wifi_ssid[CFG_SSID_LEN];
    char wifi_password[CFG_PW_LEN];
    bool setup_done;
} device_config_t;

extern device_config_t g_cfg;

// Call once after nvs_flash_init(), before ble_server_init()
void device_config_load(void);

// Update device token only (no reboot needed)
void device_config_set_token(const char *token);

// Update refresh token only (no reboot needed)
void device_config_set_refresh_token(const char *refresh_token);

// Save all BLE UUIDs to NVS (no reboot)
void device_config_save_ble(const char *svc, const char *read,
                             const char *write, const char *mfr);

// Update all BLE UUIDs and reboot to apply
void device_config_update_ble(const char *svc, const char *read,
                               const char *write, const char *mfr);

// Save WiFi credentials (NULL이면 생략, Zigbee 모델) + mark setup complete, then reboot
void device_config_set_setup_complete(const char *ssid, const char *pw);

// Clear setup_done + WiFi credentials from NVS, then reboot
void device_config_factory_reset(void);
