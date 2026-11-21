#include "app_config.h"
#include "device_config.h"
#include "led_indicator.h"
#include "servo_motor.h"
#include "ble_server.h"
#include "transport.h"

#include "nvs_flash.h"
#include "esp_log.h"
#include "esp_pm.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

static const char *TAG = "main";

// ── BOOT button: hold 5s → factory reset ─────────────────────────────────────
// 눌림(하강 에지) 인터럽트로 깨어나 누르고 있는 동안만 100ms 폴링한다(상시 폴링은 CPU를 계속 깨운다).
static TaskHandle_t s_btn_task;

static void IRAM_ATTR boot_btn_isr(void *arg)
{
    BaseType_t woken = pdFALSE;
    vTaskNotifyGiveFromISR(s_btn_task, &woken);
    portYIELD_FROM_ISR(woken);
}

static void boot_btn_task(void *arg)
{
    gpio_config_t btn_cfg = {
        .pin_bit_mask  = (1ULL << BOOT_BTN_GPIO),
        .mode          = GPIO_MODE_INPUT,
        .pull_up_en    = GPIO_PULLUP_ENABLE,
        .pull_down_en  = GPIO_PULLDOWN_DISABLE,
        .intr_type     = GPIO_INTR_NEGEDGE,
    };
    s_btn_task = xTaskGetCurrentTaskHandle();
    gpio_config(&btn_cfg);
    ESP_ERROR_CHECK(gpio_install_isr_service(0));
    ESP_ERROR_CHECK(gpio_isr_handler_add(BOOT_BTN_GPIO, boot_btn_isr, NULL));

    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
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

#if CONFIG_PM_ENABLE
    // 쉴 때 CPU 클럭을 XTAL(40MHz)까지 낮춘다. light sleep은 BLE 절전(CONFIG_BT_LE_SLEEP_ENABLE)을 켤 때 함께 켠다.
    esp_pm_config_t pm_cfg = {
        .max_freq_mhz       = CONFIG_ESP_DEFAULT_CPU_FREQ_MHZ,
        .min_freq_mhz       = 40,
        .light_sleep_enable = false,
    };
    ESP_ERROR_CHECK(esp_pm_configure(&pm_cfg));
#endif

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
