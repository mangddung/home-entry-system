#include "led_indicator.h"
#include "app_config.h"
#include "led_strip.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

static const char *TAG = "led";
static led_strip_handle_t s_strip;

// Generation counter: incrementing tells the current blink task to stop.
// Each task captures its generation at creation and exits when it changes.
// No task handles are stored — eliminates all vTaskDelete race conditions.
static volatile uint8_t s_gen = 0;

void led_indicator_init(void)
{
    led_strip_config_t strip_cfg = {
        .strip_gpio_num = LED_GPIO,
        .max_leds       = 1,
        .color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_GRB,
        .led_model              = LED_MODEL_WS2812,
    };
    led_strip_rmt_config_t rmt_cfg = {
        .resolution_hz  = 10 * 1000 * 1000,
        .flags.with_dma = false,
    };
    ESP_ERROR_CHECK(led_strip_new_rmt_device(&strip_cfg, &rmt_cfg, &s_strip));
    led_strip_clear(s_strip);
    ESP_LOGI(TAG, "WS2812 initialized on GPIO%d", LED_GPIO);
}

void led_set_color(uint8_t r, uint8_t g, uint8_t b)
{
    led_strip_set_pixel(s_strip, 0, r, g, b);
    led_strip_refresh(s_strip);
}

void led_off(void)
{
    led_strip_clear(s_strip);
    led_strip_refresh(s_strip);
}

// ── Blink tasks ───────────────────────────────────────────────────────────────

static void task_idle_blink(void *arg)
{
    uint8_t my_gen = (uint8_t)(uintptr_t)arg;
    const uint8_t B = 77;
    while (s_gen == my_gen) {
        led_set_color(0, 0, B);
        vTaskDelay(pdMS_TO_TICKS(500));
        if (s_gen != my_gen) break;
        led_off();
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    vTaskDelete(NULL);
}

void led_idle_blink_start(void)
{
    s_gen++;
    led_off();
    xTaskCreate(task_idle_blink, "led_idle", 2048,
                (void *)(uintptr_t)s_gen, 3, NULL);
}

static void task_notify_success(void *arg)
{
    uint8_t my_gen = (uint8_t)(uintptr_t)arg;
    const uint8_t G = 77;
    led_set_color(0, G, 0);
    for (int i = 0; i < 20 && s_gen == my_gen; i++)
        vTaskDelay(pdMS_TO_TICKS(100));
    if (s_gen == my_gen) {
        s_gen++;
        led_off();
    }
    vTaskDelete(NULL);
}

void led_notify_success(void)
{
    s_gen++;
    xTaskCreate(task_notify_success, "led_ok", 2048,
                (void *)(uintptr_t)s_gen, 3, NULL);
}

static void task_notify_fail(void *arg)
{
    uint8_t my_gen = (uint8_t)(uintptr_t)arg;
    const uint8_t R = 77;
    for (int i = 0; i < 10 && s_gen == my_gen; i++) {
        led_set_color(R, 0, 0);
        vTaskDelay(pdMS_TO_TICKS(200));
        if (s_gen != my_gen) break;
        led_off();
        vTaskDelay(pdMS_TO_TICKS(200));
    }
    if (s_gen == my_gen) {
        s_gen++;
        led_off();
    }
    vTaskDelete(NULL);
}

void led_notify_fail(void)
{
    s_gen++;
    xTaskCreate(task_notify_fail, "led_fail", 2048,
                (void *)(uintptr_t)s_gen, 3, NULL);
}

static void task_wifi_connecting(void *arg)
{
    uint8_t my_gen = (uint8_t)(uintptr_t)arg;
    const uint8_t R = 77, G = 77;  // yellow = R+G
    while (s_gen == my_gen) {
        led_set_color(R, G, 0);
        vTaskDelay(pdMS_TO_TICKS(500));
        if (s_gen != my_gen) break;
        led_off();
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    vTaskDelete(NULL);
}

void led_wifi_connecting(void)
{
    s_gen++;
    led_off();
    xTaskCreate(task_wifi_connecting, "led_wifi", 2048,
                (void *)(uintptr_t)s_gen, 3, NULL);
}

void led_init_ok(void)
{
    s_gen++;
    led_off();
}

void led_init_fail(void)
{
    s_gen++;
    led_set_color(77, 0, 0);
}

void led_ble_connected(void)
{
    s_gen++;
    led_set_color(0, 0, 77);  // solid blue
}

void led_reset_ok(void)
{
    s_gen++;
    led_set_color(0, 77, 0);  // solid green
}

void led_setup_timeout(void)
{
    s_gen++;
    led_set_color(77, 20, 0);  // solid orange
}
