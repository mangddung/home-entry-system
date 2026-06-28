#include "servo_motor.h"
#include "app_config.h"
#include "driver/ledc.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"

static const char *TAG = "servo";

// ── Duty calculation ──────────────────────────────────────────────────────────
// 16-bit resolution at 50 Hz: period = 20 000 µs, ticks = 65 536
// duty = (pulse_us / 20000) * 65536
static uint32_t level_to_duty(float level)
{
    if (level < -1.0f) level = -1.0f;
    if (level >  1.0f) level =  1.0f;
    float us = SERVO_MIN_US + (level + 1.0f) * 0.5f * (SERVO_MAX_US - SERVO_MIN_US);
    return (uint32_t)(us / 20000.0f * 65536.0f);
}

void servo_init(void)
{
    ledc_timer_config_t timer = {
        .speed_mode      = LEDC_LOW_SPEED_MODE,
        .timer_num       = SERVO_LEDC_TIMER,
        .duty_resolution = SERVO_LEDC_RESOLUTION,
        .freq_hz         = SERVO_FREQ_HZ,
        .clk_cfg         = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer));

    ledc_channel_config_t channel = {
        .gpio_num   = SERVO_GPIO,
        .speed_mode = LEDC_LOW_SPEED_MODE,
        .channel    = SERVO_LEDC_CHANNEL,
        .timer_sel  = SERVO_LEDC_TIMER,
        .duty       = level_to_duty(0.0f),
        .hpoint     = 0,
    };
    ESP_ERROR_CHECK(ledc_channel_config(&channel));
    ESP_LOGI(TAG, "LEDC servo init on GPIO%d at %d Hz", SERVO_GPIO, SERVO_FREQ_HZ);
}

void servo_write(float level)
{
    uint32_t duty = level_to_duty(level);
    ledc_set_duty(LEDC_LOW_SPEED_MODE, SERVO_LEDC_CHANNEL, duty);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, SERVO_LEDC_CHANNEL);
}

// ── Activate task (runs servo_activate without blocking caller) ───────────────
static void activate_task(void *arg)
{
    ESP_LOGI(TAG, "Servo activation started");
    float low  = servo_get_low();
    float high = servo_get_high();
    servo_write(low);
    vTaskDelay(pdMS_TO_TICKS(1000));
    servo_write(high);
    vTaskDelay(pdMS_TO_TICKS(1000));
    ESP_LOGI(TAG, "Servo activation completed");
    vTaskDelete(NULL);
}

void servo_activate(void)
{
    xTaskCreate(activate_task, "servo_act", 2048, NULL, 5, NULL);
}

// ── NVS persistence ───────────────────────────────────────────────────────────
static float nvs_read_float(const char *ns, const char *key, float def)
{
    nvs_handle_t h;
    if (nvs_open(ns, NVS_READONLY, &h) != ESP_OK) return def;
    uint32_t raw = 0;
    esp_err_t err = nvs_get_u32(h, key, &raw);
    nvs_close(h);
    if (err != ESP_OK) return def;
    float val;
    __builtin_memcpy(&val, &raw, sizeof(val));
    return val;
}

static void nvs_write_float(const char *ns, const char *key, float val)
{
    nvs_handle_t h;
    if (nvs_open(ns, NVS_READWRITE, &h) != ESP_OK) return;
    uint32_t raw;
    __builtin_memcpy(&raw, &val, sizeof(raw));
    nvs_set_u32(h, key, raw);
    nvs_commit(h);
    nvs_close(h);
}

float servo_get_low(void)
{
    return nvs_read_float(NVS_NS_SERVO, NVS_KEY_SRV_LOW, SERVO_LOW_DEFAULT);
}

float servo_get_high(void)
{
    return nvs_read_float(NVS_NS_SERVO, NVS_KEY_SRV_HIGH, SERVO_HIGH_DEFAULT);
}

void servo_set_low(float level)
{
    nvs_write_float(NVS_NS_SERVO, NVS_KEY_SRV_LOW, level);
}

void servo_set_high(float level)
{
    nvs_write_float(NVS_NS_SERVO, NVS_KEY_SRV_HIGH, level);
}
