#include "battery.h"

#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"

static const char *TAG = "battery";

// 캐리어 보드: 셀 전압을 R9·R10(1M/1M)으로 절반으로 나눠 H1 8번 = GPIO0 = ADC1_CH0에 넣는다.
#define BAT_ADC_CHANNEL  ADC_CHANNEL_0
#define BAT_ADC_ATTEN    ADC_ATTEN_DB_12
#define BAT_SAMPLES      16
// 실측 보정값 = 1000 * 테스터 전압 / 보고 전압. 저항 오차와 ADC 입력 누설을 한 점에서 맞춘다.
#define BAT_CAL_PERMILLE 1000
// 이보다 낮으면 셀이 없다고 본다. 서버 BATTERY_MV_MIN과 같은 값.
#define BAT_MIN_MV       2500

static adc_oneshot_unit_handle_t s_adc;
static adc_cali_handle_t         s_cali;

static bool adc_ready(void)
{
    if (s_cali) return true;

    adc_oneshot_unit_init_cfg_t unit = { .unit_id = ADC_UNIT_1 };
    adc_oneshot_chan_cfg_t chan = { .atten = BAT_ADC_ATTEN, .bitwidth = ADC_BITWIDTH_DEFAULT };
    adc_cali_curve_fitting_config_t cali = {
        .unit_id  = ADC_UNIT_1,
        .chan     = BAT_ADC_CHANNEL,
        .atten    = BAT_ADC_ATTEN,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    if ((!s_adc && adc_oneshot_new_unit(&unit, &s_adc) != ESP_OK) ||
        adc_oneshot_config_channel(s_adc, BAT_ADC_CHANNEL, &chan) != ESP_OK ||
        adc_cali_create_scheme_curve_fitting(&cali, &s_cali) != ESP_OK) {
        ESP_LOGE(TAG, "ADC init failed");
        return false;
    }
    return true;
}

// ponytail: 서보가 움직이는 중에 재면 전압이 처진 값이 다음 ping(5분)까지 남는다. 눈에 띄면 동작이 끝난 뒤에 잰다.
int battery_read_mv(void)
{
    if (!adc_ready()) return 0;

    int sum = 0;
    for (int i = 0; i < BAT_SAMPLES; i++) {
        int mv;
        if (adc_oneshot_get_calibrated_result(s_adc, s_cali, BAT_ADC_CHANNEL, &mv) != ESP_OK) return 0;
        sum += mv;
    }
    int cell_mv = sum / BAT_SAMPLES * 2 * BAT_CAL_PERMILLE / 1000;
    ESP_LOGI(TAG, "Cell %d mV", cell_mv);
    return cell_mv >= BAT_MIN_MV ? cell_mv : 0;
}
