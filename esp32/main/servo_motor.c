#include "servo_motor.h"
#include "app_config.h"
#include "driver/ledc.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "esp_log.h"
#include "esp_timer.h"

static const char *TAG = "servo";

#define SERVO_MOVE_MS 1000  // 한 위치로 이동을 기다리는 시간. 느린 서보·큰 범위면 늘린다.
#define SERVO_PREVIEW_HOLD_MS 1500  // 실시간 조절 입력이 멈춘 뒤 펄스를 끊기까지 시간

// 움직임 하나가 펄스를 끊을 때까지 다음 움직임을 기다리게 한다.
// 겹치면 먼저 끝난 쪽이 다른 쪽 동작 중에 펄스를 끊는다.
static SemaphoreHandle_t s_motion_lock;
static esp_timer_handle_t s_preview_timer;

static void preview_release_cb(void *arg);

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
    s_motion_lock = xSemaphoreCreateMutex();

    const esp_timer_create_args_t preview_args = {
        .callback = preview_release_cb,
        .name     = "servo_preview",
    };
    ESP_ERROR_CHECK(esp_timer_create(&preview_args, &s_preview_timer));

    ledc_timer_config_t timer = {
        .speed_mode      = LEDC_LOW_SPEED_MODE,
        .timer_num       = SERVO_LEDC_TIMER,
        .duty_resolution = SERVO_LEDC_RESOLUTION,
        .freq_hz         = SERVO_FREQ_HZ,
        .clk_cfg         = LEDC_USE_XTAL_CLK,  // CPU 클럭을 낮춰도(PM) 펄스 폭이 흔들리지 않게 고정 클럭
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

// 펄스를 끊어 위치 유지를 멈춘다. 대기 중 떨림·발열·전원 부담이 사라지는 대신 유지 토크도 없다.
static void servo_release(void)
{
    ledc_set_duty(LEDC_LOW_SPEED_MODE, SERVO_LEDC_CHANNEL, 0);
    ledc_update_duty(LEDC_LOW_SPEED_MODE, SERVO_LEDC_CHANNEL);
}

// ── Motion task (runs without blocking caller) ────────────────────────────────
// arg != NULL: low → high (문 열기), NULL: high만 (부팅 시 대기 위치로)
static void motion_task(void *arg)
{
    xSemaphoreTake(s_motion_lock, portMAX_DELAY);
    if (arg) {
        ESP_LOGI(TAG, "Servo activation started");
        servo_write(servo_get_low());
        vTaskDelay(pdMS_TO_TICKS(SERVO_MOVE_MS));
    }
    servo_write(servo_get_high());
    vTaskDelay(pdMS_TO_TICKS(SERVO_MOVE_MS));
    servo_release();
    ESP_LOGI(TAG, "Servo motion completed");
    xSemaphoreGive(s_motion_lock);
    vTaskDelete(NULL);
}

void servo_activate(void)
{
    xTaskCreate(motion_task, "servo_act", 2048, (void *)1, 5, NULL);
}

void servo_rest(void)
{
    xTaskCreate(motion_task, "servo_rest", 2048, NULL, 5, NULL);
}

// ── Live preview ──────────────────────────────────────────────────────────────
static void preview_release_cb(void *arg)
{
    // 동작 중이면 motion_task가 끝날 때 펄스를 끊는다
    if (xSemaphoreTake(s_motion_lock, 0) != pdTRUE) return;
    servo_release();
    xSemaphoreGive(s_motion_lock);
}

void servo_preview_deg(int deg)
{
    // 다음 드래그 값이 곧 따라오므로 기다리지 않고 버린다
    if (xSemaphoreTake(s_motion_lock, 0) != pdTRUE) return;
    servo_write(deg / 90.0f - 1.0f);
    xSemaphoreGive(s_motion_lock);
    esp_timer_stop(s_preview_timer);
    esp_timer_start_once(s_preview_timer, (uint64_t)SERVO_PREVIEW_HOLD_MS * 1000);
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

// level -1~1이 펄스 SERVO_MIN_US~MAX_US, 곧 0~180°에 대응한다
void servo_get_range_deg(int *low_deg, int *high_deg)
{
    *low_deg  = (int)((servo_get_low()  + 1.0f) * 90.0f + 0.5f);
    *high_deg = (int)((servo_get_high() + 1.0f) * 90.0f + 0.5f);
}

void servo_set_range_deg(int low_deg, int high_deg)
{
    servo_set_low(low_deg / 90.0f - 1.0f);
    servo_set_high(high_deg / 90.0f - 1.0f);
}
