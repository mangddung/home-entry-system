#include "app_config.h"
#include "device_config.h"
#include "led_indicator.h"
#include "servo_motor.h"
#include "ble_server.h"
#include "transport.h"

#include "nvs_flash.h"
#include "esp_log.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "main";

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
                    transport_notify_reset();       // 결과 무관
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
    servo_rest();

    transport_init();

    // BOOT button monitor (active in both modes)
    xTaskCreate(boot_btn_task, "boot_btn", 6144, NULL, 3, NULL);

    if (!g_cfg.setup_done) {
        ESP_LOGI(TAG, "=== Setup mode (not provisioned) ===");
        led_idle_blink_start();
        ble_setup_server_init();
        // Setup flow is event-driven from here; RTOS scheduler takes over
    } else {
        ESP_LOGI(TAG, "=== Normal mode (DoorLock firmware) ===");
        transport_start();
        ble_server_init();
        // All work is event-driven from here
    }
}
