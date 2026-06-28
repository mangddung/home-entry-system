#include "app_config.h"
#include "device_config.h"
#include "led_indicator.h"
#include "servo_motor.h"
#include "ble_server.h"
#include "http_api.h"

#include "nvs_flash.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "esp_event.h"
#include "esp_log.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"

static const char *TAG = "main";

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

// ── BOOT button: hold 5s → factory reset ─────────────────────────────────────
static void boot_btn_task(void *arg)
{
    gpio_config_t btn_cfg = {
        .pin_bit_mask  = (1ULL << BOOT_BTN_GPIO),
        .mode          = GPIO_MODE_INPUT,
        .pull_up_en    = GPIO_PULLUP_ENABLE,
        .pull_down_en  = GPIO_PULLDOWN_DISABLE,
        .intr_type     = GPIO_INTR_DISABLE,
    };
    gpio_config(&btn_cfg);

    for (;;) {
        if (gpio_get_level(BOOT_BTN_GPIO) == 0) {
            uint32_t held_ms = 0;
            while (gpio_get_level(BOOT_BTN_GPIO) == 0) {
                vTaskDelay(pdMS_TO_TICKS(100));
                held_ms += 100;
                if (held_ms >= BOOT_RESET_HOLD_MS) {
                    ESP_LOGI(TAG, "Factory reset triggered by BOOT button");
                    led_reset_ok();
                    http_notify_reset();            // 2회 시도, 결과 무관
                    device_config_factory_reset();  // never returns
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

// ── Entry point ───────────────────────────────────────────────────────────────
void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    device_config_load();
    led_indicator_init();
    servo_init();
    servo_write(servo_get_high());

    // Always initialize netif and event loop (needed by both setup and normal WiFi)
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    // BOOT button monitor (active in both modes)
    xTaskCreate(boot_btn_task, "boot_btn", 6144, NULL, 3, NULL);

    if (!g_cfg.setup_done) {
        ESP_LOGI(TAG, "=== Setup mode (not provisioned) ===");
        led_idle_blink_start();
        ble_setup_server_init();
        // Setup flow is event-driven from here; RTOS scheduler takes over
    } else {
        ESP_LOGI(TAG, "=== Normal mode (DoorLock firmware) ===");
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

        ble_server_init();
        // All work is event-driven from here
    }
}
