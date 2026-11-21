// Zigbee 모델 transport: End Device로 게이트웨이(코디네이터)에 붙어 서버와 메시지를 주고받는다.
// 경로: 기기 ─Zigbee─ 게이트웨이(Zigbee2MQTT) ─MQTT─ 서버 MQTT 워커(server/mqtt_worker.py)
//
// 앱 프로토콜 메시지는 커스텀 클러스터(ZB_APP_CLUSTER_ID) 명령 하나로 오간다.
//   payload = [len][type][seq][data...][tag(8)]   (ZCL octet string. gateway/z2m 외부 컨버터와 형식 공유)
//   기기 → 서버: 방향 to client / 서버 → 기기: 방향 to server
//   tag = HMAC-SHA256(기기 비밀키, ...)의 앞 8바이트. 키는 gen_config가 굽는 IOT_DEVICE_SECRET_KEY(서버도 보관).
//     요청: HMAC(key, req_type||seq||req_data)
//     응답: HMAC(key, 요청(태그 제외) || rsp_type||seq||rsp_data)  → 응답이 해당 요청에 묶여 재사용·위조 불가
//   Zigbee 네트워크 키를 가진 다른 노드(같은 게이트웨이에 붙은 전구 등)가 "인증 성공" 응답을 위조해 문을 열지 못하게 한다.
// ponytail: 요청 재전송(옛 RESET 등) 방지는 서버 중복 제거(짧은 TTL)뿐이다. install code·카운터 단계에서 보완.
//   예외: ZB_MSG_CHECK_REG는 서버가 먼저 보내는 태그 없는 신호다. 받으면 ping을 앞당길 뿐이고
//   초기화 여부는 태그가 붙은 ping 응답으로만 정한다(위조·재전송돼도 ping이 한 번 늘 뿐).
//
// Sleepy End Device: 수신기는 꺼 두고 ZB_POLL_MS마다 부모에게 쌓인 메시지를 가져온다.
// 응답을 기다리는 동안만 ZB_FAST_POLL_MS로 당긴다(keepalive 주기 = poll 주기, esp-zigbee-lib 2.x).
//
// 표준 Door Lock 클러스터는 잠금 상태 보고용이다. 표준 lock/unlock 명령은 서버의 멤버/게스트
// 권한 체크를 거치지 않는 경로라 거부한다(원격 열기는 서버 명령 경로로 추가할 것).
#include "transport.h"
#include "app_config.h"
#include "device_config.h"
#include "led_indicator.h"
#include "servo_motor.h"
#include "ble_server.h"
#include "battery.h"

#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_zigbee.h"
#include "ezbee/zha.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"
#include "freertos/event_groups.h"
#include "psa/crypto.h"
#include "cJSON.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

static const char *TAG = "zigbee";

// ── 프로토콜 상수 (gateway/z2m/data/external_converters/doorlock.mjs, server/mqtt_worker.py와 짝) ──
#define ZB_EP_ID            10
#define ZB_COORD_EP_ID      1
#define ZB_APP_CLUSTER_ID   0xFC00
#define ZB_APP_CMD_ID       0x00
#define ZB_APP_ATTR_VERSION 0x0000      // 프로토콜 버전 (읽기 전용)
#define ZB_APP_VERSION      1
#define ZB_MSG_MAX          48          // data 최대 길이. 태그 포함 단일 Zigbee 프레임(ZCL ≈80B)에 들어가도록
#define ZB_TAG_LEN          8
#define ZB_MAC_ALG          PSA_ALG_TRUNCATED_MAC(PSA_ALG_HMAC(PSA_ALG_SHA_256), ZB_TAG_LEN)

#define ZB_MANUFACTURER_NAME "\x05" "DoorL"
#define ZB_MODEL_IDENTIFIER  "\x0b" "doorl-zb-v1"

#define ZB_ALL_CHANNELS_MASK 0x07FFF800U  // 11~26. 채널은 게이트웨이(Z2M)가 정한다

enum {
    ZB_MSG_PING           = 0x01,  // data: [flags] bit0 = 부팅 직후, + rand(4) (응답 재사용 방지), + 셀 전압 mV(2, little-endian, 0 = 없음)
    ZB_MSG_VALIDATE_TOKEN = 0x02,  // data: nonce(8) + mac(32)
    ZB_MSG_VALIDATE_SETUP = 0x03,  // data: setup_token (ASCII)
    ZB_MSG_RESET          = 0x04,  // data: -
    ZB_MSG_PING_RESULT    = 0x81,  // data: [registered]
    ZB_MSG_AUTH_RESULT    = 0x82,  // data: [status]
    ZB_MSG_SETUP_RESULT   = 0x83,  // data: [status] (+ seed(16) when ok)
    ZB_MSG_RESET_RESULT   = 0x84,  // data: [status]
    ZB_MSG_CHECK_REG      = 0x85,  // 서버 → 기기, 태그 없음: 기기가 삭제됐으니 바로 ping 하라 (data: -)
};
#define ZB_STATUS_OK     0
#define ZB_RSP_FIRST     ZB_MSG_PING_RESULT
#define ZB_RSP_COUNT     4

#define ZB_PING_RETRY_MS   (30 * 1000)
#define ZB_STEER_RETRY_MS  5000
#define ZB_SETUP_JOIN_MS   (60 * 1000)    // 셋업 시 네트워크 가입 대기 (서버가 permit join을 180초 연다)
#define ZB_SETUP_SERVER_MS (60 * 1000)    // 셋업 시 서버 응답 대기 (Z2M 인터뷰가 끝나야 메시지가 전달된다)
#define ZB_RSP_TIMEOUT_MS  5000
// 평소 poll 주기. 게이트웨이(Z-Stack)가 잠든 기기 몫 메시지를 약 7초만 들고 있어 그보다 짧게 둔다.
#define ZB_POLL_MS          5000
#define ZB_FAST_POLL_MS     200
#define ZB_CHECK_REG_MIN_US (30 * 1000 * 1000LL)  // CHECK_REG로 ping을 앞당기는 최소 간격(반복 신호 방어)

typedef struct {
    uint8_t type;
    uint8_t seq;
    uint8_t len;                           // data 길이 (수신 직후엔 태그 포함, 검증 후 제외)
    uint8_t data[ZB_MSG_MAX + ZB_TAG_LEN];
} zb_msg_t;

static QueueHandle_t      s_rsp_q[ZB_RSP_COUNT];  // 응답 type별 수신함 (Zigbee 태스크가 채움)
static EventGroupHandle_t s_zb_eg;
#define ZB_JOINED_BIT BIT0

static uint8_t            s_seq;               // 재부팅 직후 같은 seq가 서버 중복 제거에 걸리지 않게 무작위 시작
static esp_timer_handle_t s_steer_timer;
static psa_key_id_t       s_key;
static volatile bool      s_stack_ready   = false;  // 스택 초기화(FIRST_START/REBOOT 신호) 완료
static volatile bool      s_steer_allowed = false;  // 셋업 모드에선 앱이 셋업 토큰을 보낸 뒤에만 가입을 시도한다
// 재시도 타이머가 할 일: 저장된 네트워크가 있으면 재가입(INITIALIZATION), 없으면 새 가입(STEERING).
// 새 가입은 게이트웨이가 permit join을 열어야만 되므로 이미 가입했던 기기의 재가입에 쓰면 계속 거절된다.
static volatile uint8_t   s_retry_mode    = EZB_BDB_MODE_NETWORK_STEERING;
static int                s_fast_poll_users;   // 응답 대기 중인 요청 수 (Zigbee 락 안에서만 바꾼다)
static TaskHandle_t       s_ping_task;          // 일반 모드에서만 있다
static int64_t            s_last_check_reg_us = -ZB_CHECK_REG_MIN_US;

// ── 메시지 인증 ───────────────────────────────────────────────────────────────
static bool zb_mac(const uint8_t *in, size_t in_len, uint8_t tag[ZB_TAG_LEN])
{
    size_t out_len;
    return psa_mac_compute(s_key, ZB_MAC_ALG, in, in_len, tag, ZB_TAG_LEN, &out_len) == PSA_SUCCESS;
}

// ── 송신 ──────────────────────────────────────────────────────────────────────
// buf: [len][type][seq][data][tag] 를 만들어 보낸다. 태그 입력(= buf+1, 태그 앞까지)은 응답 검증에 다시 쓴다.
static bool zb_send(const uint8_t *msg, uint8_t msg_len)
{
    uint8_t buf[1 + 2 + ZB_MSG_MAX + ZB_TAG_LEN];
    buf[0] = msg_len + ZB_TAG_LEN;  // octet string 길이
    memcpy(buf + 1, msg, msg_len);
    if (!zb_mac(msg, msg_len, buf + 1 + msg_len)) {
        ESP_LOGE(TAG, "message tag failed");
        return false;
    }

    ezb_zcl_custom_cluster_cmd_t req = {
        .cmd_ctrl = {
            .dst_addr   = EZB_ADDRESS_SHORT(0x0000),  // 코디네이터 = 게이트웨이
            .dst_ep     = ZB_COORD_EP_ID,
            .src_ep     = ZB_EP_ID,
            .cluster_id = ZB_APP_CLUSTER_ID,
            .manuf_code = EZB_ZCL_STD_MANUF_CODE,
            .fc         = {.direction = EZB_ZCL_CMD_DIRECTION_TO_CLI, .dis_default_rsp = true},
        },
        .cmd_id      = ZB_APP_CMD_ID,
        .data_length = 1 + msg_len + ZB_TAG_LEN,
        .data        = buf,
    };
    esp_zigbee_lock_acquire(portMAX_DELAY);
    ezb_err_t err = ezb_zcl_custom_cluster_cmd_req(&req);
    esp_zigbee_lock_release();
    if (err != EZB_ERR_NONE) {
        ESP_LOGW(TAG, "send type 0x%02x failed (0x%x)", msg[0], err);
        return false;
    }
    return true;
}

// 응답 대기 중에는 poll을 당긴다. 동시에 기다리는 요청이 있으면 마지막 요청이 끝날 때 되돌린다.
static void zb_fast_poll(bool on)
{
    esp_zigbee_lock_acquire(portMAX_DELAY);
    s_fast_poll_users += on ? 1 : -1;
    if (s_fast_poll_users == (on ? 1 : 0)) {
        ezb_nwk_set_keepalive_interval(on ? ZB_FAST_POLL_MS : ZB_POLL_MS);
    }
    esp_zigbee_lock_release();
}

// 요청을 보내고 같은 seq + 올바른 태그의 응답을 기다린다. 응답이 없으면 false.
// 성공하면 rsp->len은 태그를 뺀 data 길이다.
static bool zb_send_and_wait(uint8_t type, const void *data, uint8_t len,
                             uint8_t rsp_type, zb_msg_t *rsp, uint32_t timeout_ms)
{
    if (len > ZB_MSG_MAX) return false;
    QueueHandle_t q = s_rsp_q[rsp_type - ZB_RSP_FIRST];
    xQueueReset(q);  // 지난 요청의 늦은 응답 버림

    // 응답 태그 입력 = 요청(태그 제외) || 응답(태그 제외)
    uint8_t mac_in[2 + ZB_MSG_MAX + 2 + ZB_MSG_MAX];
    uint8_t seq = ++s_seq;
    mac_in[0] = type;
    mac_in[1] = seq;
    if (len) memcpy(mac_in + 2, data, len);
    size_t req_len = 2 + len;
    if (!zb_send(mac_in, req_len)) return false;

    TickType_t deadline = xTaskGetTickCount() + pdMS_TO_TICKS(timeout_ms);
    for (;;) {
        TickType_t now = xTaskGetTickCount();
        if ((int32_t)(deadline - now) <= 0) return false;
        if (xQueueReceive(q, rsp, deadline - now) != pdTRUE) return false;
        if (rsp->seq != seq || rsp->len < ZB_TAG_LEN || rsp->len - ZB_TAG_LEN > ZB_MSG_MAX) continue;

        uint8_t data_len = rsp->len - ZB_TAG_LEN;
        mac_in[req_len]     = rsp->type;
        mac_in[req_len + 1] = rsp->seq;
        memcpy(mac_in + req_len + 2, rsp->data, data_len);
        if (psa_mac_verify(s_key, ZB_MAC_ALG, mac_in, req_len + 2 + data_len,
                           rsp->data + data_len, ZB_TAG_LEN) != PSA_SUCCESS) {
            ESP_LOGW(TAG, "response 0x%02x with bad tag dropped", rsp->type);
            continue;
        }
        rsp->len = data_len;
        return true;
    }
}

static bool zb_request(uint8_t type, const void *data, uint8_t len,
                       uint8_t rsp_type, zb_msg_t *rsp, uint32_t timeout_ms)
{
    zb_fast_poll(true);
    bool ok = zb_send_and_wait(type, data, len, rsp_type, rsp, timeout_ms);
    zb_fast_poll(false);
    return ok;
}

// ── 수신 (Zigbee 태스크 컨텍스트: 막히는 작업 금지, 큐로 넘긴다) ──────────────
static ezb_zcl_status_t app_cluster_cmd_handler(const ezb_zcl_cmd_hdr_t *header,
                                                const uint8_t *payload, uint16_t payload_length)
{
    if (header->cluster_id != ZB_APP_CLUSTER_ID || header->cmd_id != ZB_APP_CMD_ID ||
        EZB_ZCL_CMD_FC_IS_TO_CLI_DIRECTION(header->fc)) {
        return EZB_ZCL_STATUS_UNSUP_CMD;
    }
    // 서버 응답은 게이트웨이(코디네이터)를 거쳐서만 온다. 위조 방지는 태그가 맡고 이건 1차 필터다.
    if (header->src_addr.addr_mode != EZB_ADDR_MODE_SHORT || header->src_addr.u.short_addr != 0x0000) {
        ESP_LOGW(TAG, "app message from non-coordinator dropped");
        return EZB_ZCL_STATUS_NOT_AUTHORIZED;
    }
    // [len][type][seq][data...][tag]
    if (payload_length < 3 || payload[0] < 2 || payload[0] > payload_length - 1 ||
        payload[0] - 2 > ZB_MSG_MAX + ZB_TAG_LEN) {
        ESP_LOGW(TAG, "malformed app message (%u bytes)", payload_length);
        return EZB_ZCL_STATUS_MALFORMED_CMD;
    }
    zb_msg_t m = {.type = payload[1], .seq = payload[2], .len = payload[0] - 2};
    memcpy(m.data, payload + 3, m.len);

    if (m.type == ZB_MSG_CHECK_REG) {
        int64_t now = esp_timer_get_time();
        if (s_ping_task && now - s_last_check_reg_us >= ZB_CHECK_REG_MIN_US) {
            s_last_check_reg_us = now;
            ESP_LOGI(TAG, "Server asked for registration check – ping now");
            xTaskNotifyGive(s_ping_task);
        }
        return EZB_ZCL_STATUS_SUCCESS;
    }

    if (m.type < ZB_RSP_FIRST || m.type >= ZB_RSP_FIRST + ZB_RSP_COUNT) {
        ESP_LOGW(TAG, "unknown app message type 0x%02x", m.type);
        return EZB_ZCL_STATUS_SUCCESS;
    }
    xQueueOverwrite(s_rsp_q[m.type - ZB_RSP_FIRST], &m);
    return EZB_ZCL_STATUS_SUCCESS;
}

static uint8_t app_cluster_disc_cmd_handler(bool is_recv, uint8_t **list)
{
    static uint8_t cmd_list[] = {ZB_APP_CMD_ID};
    *list = cmd_list;
    return 1;
}

static void app_cluster_init(uint8_t ep_id)
{
    (void)ep_id;
    ezb_zcl_custom_cluster_handlers_t handlers = {
        .cluster_id     = ZB_APP_CLUSTER_ID,
        .cluster_role   = EZB_ZCL_CLUSTER_SERVER,
        .process_cmd_cb = app_cluster_cmd_handler,
        .cmd_disc_cb    = app_cluster_disc_cmd_handler,
    };
    ezb_zcl_custom_cluster_handlers_register(&handlers);
}

static void app_cluster_deinit(uint8_t ep_id) { (void)ep_id; }

static void zcl_core_action_handler(ezb_zcl_core_action_callback_id_t callback_id, void *message)
{
    switch (callback_id) {
    case EZB_ZCL_CORE_DOOR_LOCK_LOCK_DOOR_CB_ID:
    case EZB_ZCL_CORE_DOOR_LOCK_UNLOCK_DOOR_CB_ID: {
        // 표준 원격 lock/unlock은 서버 권한 체크를 우회하므로 받지 않는다(파일 머리 주석)
        ezb_zcl_door_lock_lock_door_message_t *msg = message;
        msg->out.result = EZB_ZCL_STATUS_NOT_AUTHORIZED;
        ESP_LOGW(TAG, "standard door lock command rejected");
    } break;
    default:
        ESP_LOGD(TAG, "ZCL core action 0x%04lx", callback_id);
        break;
    }
}

// ── 기기 데이터 모델 ──────────────────────────────────────────────────────────
static void create_device(void)
{
    ezb_af_device_desc_t      dev_desc = ezb_af_create_device_desc();
    ezb_zha_door_lock_config_t lock_cfg = EZB_ZHA_DOOR_LOCK_CONFIG();
    lock_cfg.basic_cfg.power_source    = EZB_ZCL_BASIC_POWER_SOURCE_BATTERY;
    lock_cfg.door_lock_cfg.lock_state  = EZB_ZCL_DOOR_LOCK_LOCK_STATE_LOCKED;  // 서보는 열고 바로 다시 잠근다
    ezb_af_ep_desc_t ep_desc = ezb_zha_create_door_lock(ZB_EP_ID, &lock_cfg);

    ezb_zcl_cluster_desc_t basic_desc =
        ezb_af_endpoint_get_cluster_desc(ep_desc, EZB_ZCL_CLUSTER_ID_BASIC, EZB_ZCL_CLUSTER_SERVER);
    ezb_zcl_basic_cluster_desc_add_attr(basic_desc, EZB_ZCL_ATTR_BASIC_MANUFACTURER_NAME_ID, (void *)ZB_MANUFACTURER_NAME);
    ezb_zcl_basic_cluster_desc_add_attr(basic_desc, EZB_ZCL_ATTR_BASIC_MODEL_IDENTIFIER_ID, (void *)ZB_MODEL_IDENTIFIER);

    ezb_zcl_custom_cluster_config_t app_cfg = {
        .cluster_id  = ZB_APP_CLUSTER_ID,
        .init_func   = app_cluster_init,
        .deinit_func = app_cluster_deinit,
    };
    ezb_zcl_cluster_desc_t app_desc = ezb_zcl_custom_create_cluster_desc(&app_cfg, EZB_ZCL_CLUSTER_SERVER);
    uint8_t version = ZB_APP_VERSION;
    ezb_zcl_custom_cluster_desc_add_attr(app_desc, ZB_APP_ATTR_VERSION, EZB_ZCL_ATTR_TYPE_UINT8,
                                         EZB_ZCL_ATTR_ACCESS_READ, &version);
    ESP_ERROR_CHECK(ezb_af_endpoint_add_cluster_desc(ep_desc, app_desc));

    ESP_ERROR_CHECK(ezb_af_device_add_endpoint_desc(dev_desc, ep_desc));
    ESP_ERROR_CHECK(ezb_af_device_desc_register(dev_desc));
    ezb_zcl_core_action_handler_register(zcl_core_action_handler);
}

// ── 네트워크 가입 ─────────────────────────────────────────────────────────────
// Zigbee 태스크에서 실행: 아직 연결 전이면 재가입(저장된 네트워크) 또는 새 가입(허용된 경우)을 시도한다
static void steer_in_zb_task(void *ctx)
{
    (void)ctx;
    if (!s_stack_ready || (xEventGroupGetBits(s_zb_eg) & ZB_JOINED_BIT)) return;
    if (s_retry_mode == EZB_BDB_MODE_INITIALIZATION) {
        ezb_bdb_start_top_level_commissioning(EZB_BDB_MODE_INITIALIZATION);
    } else if (s_steer_allowed) {
        ezb_bdb_start_top_level_commissioning(EZB_BDB_MODE_NETWORK_STEERING);
    }
}

static void steer_timer_cb(void *arg)
{
    (void)arg;
    esp_zigbee_task_queue_post(steer_in_zb_task, NULL);
}

static void zb_allow_steering(void)
{
    s_steer_allowed = true;
    // 스택이 아직 초기화 중이면 FIRST_START/REBOOT 신호 처리에서 직접 시작한다
    if (s_stack_ready) esp_zigbee_task_queue_post(steer_in_zb_task, NULL);
}

static void log_network(void)
{
    ezb_extaddr_t ieee;
    ezb_get_extended_address(&ieee);
    ESP_LOGI(TAG, "Joined: IEEE 0x%016llx, PAN 0x%04hx, channel %d, short 0x%04hx",
             ieee.u64, ezb_nwk_get_panid(), ezb_nwk_get_current_channel(), ezb_nwk_get_short_address());
}

static bool app_signal_handler(const ezb_app_signal_t *app_signal)
{
    ezb_app_signal_type_t type = ezb_app_signal_get_type(app_signal);

    switch (type) {
    case EZB_ZDO_SIGNAL_SKIP_STARTUP:
        ezb_bdb_start_top_level_commissioning(EZB_BDB_MODE_INITIALIZATION);
        break;
    case EZB_BDB_SIGNAL_DEVICE_FIRST_START:
    case EZB_BDB_SIGNAL_DEVICE_REBOOT: {
        ezb_bdb_comm_status_t status = *(ezb_bdb_comm_status_t *)ezb_app_signal_get_params(app_signal);
        s_stack_ready = true;
        if (status == EZB_BDB_STATUS_SUCCESS && !ezb_bdb_is_factory_new()) {
            log_network();
            xEventGroupSetBits(s_zb_eg, ZB_JOINED_BIT);
        } else if (!ezb_bdb_is_factory_new()) {
            // 저장된 네트워크 재가입 실패(게이트웨이가 잠시 응답 없음, 부팅 직후 BLE와 무선 경합 등) → 재가입만 반복
            ESP_LOGW(TAG, "%s (status 0x%02x) – rejoin retry in %d ms", ezb_app_signal_to_string(type), status,
                     ZB_STEER_RETRY_MS);
            s_retry_mode = EZB_BDB_MODE_INITIALIZATION;
            esp_timer_start_once(s_steer_timer, (uint64_t)ZB_STEER_RETRY_MS * 1000);
        } else {
            // 공장 초기 상태 → 허용되면 열린 네트워크를 찾을 때까지 주기적으로 steering
            ESP_LOGI(TAG, "%s (status 0x%02x) – %s", ezb_app_signal_to_string(type), status,
                     s_steer_allowed ? "network steering" : "waiting for setup");
            s_retry_mode = EZB_BDB_MODE_NETWORK_STEERING;
            steer_in_zb_task(NULL);
        }
    } break;
    case EZB_BDB_SIGNAL_STEERING: {
        ezb_bdb_comm_status_t status = *(ezb_bdb_comm_status_t *)ezb_app_signal_get_params(app_signal);
        if (status == EZB_BDB_STATUS_SUCCESS) {
            log_network();
            xEventGroupSetBits(s_zb_eg, ZB_JOINED_BIT);
        } else {
            ESP_LOGD(TAG, "steering failed (0x%02x) – retry", status);
            esp_timer_start_once(s_steer_timer, (uint64_t)ZB_STEER_RETRY_MS * 1000);
        }
    } break;
    case EZB_ZDO_SIGNAL_LEAVE:
        // 게이트웨이에서 제거되면(네트워크 정보 삭제) 새 가입을 시도한다(셋업 모드는 허용된 뒤에만)
        ESP_LOGW(TAG, "left network – will steer again");
        xEventGroupClearBits(s_zb_eg, ZB_JOINED_BIT);
        s_retry_mode = EZB_BDB_MODE_NETWORK_STEERING;
        esp_timer_start_once(s_steer_timer, (uint64_t)ZB_STEER_RETRY_MS * 1000);
        break;
    default:
        ESP_LOGD(TAG, "signal %s (0x%02x)", ezb_app_signal_to_string(type), type);
        break;
    }
    return true;
}

static void zb_main_task(void *arg)
{
    (void)arg;
    esp_zigbee_config_t config = {
        .device_config = {
            .device_type         = EZB_NWK_DEVICE_TYPE_END_DEVICE,
            .install_code_policy = false,  // TODO(install code): 기기별 링크 키 가입은 향후 단계
            .zed_config          = {.ed_timeout = EZB_NWK_ED_TIMEOUT_64MIN, .keep_alive = ZB_POLL_MS},
        },
        .platform_config = {
            .storage_partition_name = "nvs",
            .radio_config           = {.radio_mode = ESP_ZIGBEE_RADIO_MODE_NATIVE},
        },
    };
    ESP_ERROR_CHECK(esp_zigbee_init(&config));
    // Sleepy End Device: 가입 때 부모에게 알리는 값이라 셋업(가입) 전부터 false로 둔다
    ezb_set_rx_on_when_idle(false);
    ezb_aps_secur_enable_distributed_security(false);
    ESP_ERROR_CHECK(ezb_bdb_set_primary_channel_set(ZB_ALL_CHANNELS_MASK));
    ESP_ERROR_CHECK(ezb_bdb_set_secondary_channel_set(0));
    ESP_ERROR_CHECK(ezb_app_signal_add_handler(app_signal_handler));
    create_device();
    ESP_ERROR_CHECK(esp_zigbee_start(false));
    esp_zigbee_launch_mainloop();
    esp_zigbee_deinit();
    vTaskDelete(NULL);
}

static bool zb_wait_joined(uint32_t timeout_ms)
{
    return xEventGroupWaitBits(s_zb_eg, ZB_JOINED_BIT, pdFALSE, pdFALSE,
                               pdMS_TO_TICKS(timeout_ms)) & ZB_JOINED_BIT;
}

static bool hex_to_bytes(const char *hex, uint8_t *out, size_t n)
{
    if (strlen(hex) != n * 2) return false;
    for (size_t i = 0; i < n; i++) {
        char b[3] = {hex[2 * i], hex[2 * i + 1], 0};
        char *end;
        out[i] = (uint8_t)strtol(b, &end, 16);
        if (*end) return false;
    }
    return true;
}

// ── transport API ─────────────────────────────────────────────────────────────
void transport_init(void)
{
    s_zb_eg = xEventGroupCreate();
    for (int i = 0; i < ZB_RSP_COUNT; i++) s_rsp_q[i] = xQueueCreate(1, sizeof(zb_msg_t));
    esp_timer_create_args_t args = {.callback = steer_timer_cb, .name = "zb_steer"};
    ESP_ERROR_CHECK(esp_timer_create(&args, &s_steer_timer));
    s_seq = (uint8_t)esp_random();

    // 메시지 인증 키 (서버 device_secret_key와 같은 값)
    uint8_t secret[16];
    psa_crypto_init();
    if (!hex_to_bytes(IOT_DEVICE_SECRET_KEY, secret, sizeof(secret))) {
        ESP_LOGE(TAG, "IOT_DEVICE_SECRET_KEY invalid – server messages will fail (run gen_config)");
    } else {
        psa_key_attributes_t attr = PSA_KEY_ATTRIBUTES_INIT;
        psa_set_key_type(&attr, PSA_KEY_TYPE_HMAC);
        psa_set_key_bits(&attr, 128);
        psa_set_key_usage_flags(&attr, PSA_KEY_USAGE_SIGN_MESSAGE | PSA_KEY_USAGE_VERIFY_MESSAGE);
        psa_set_key_algorithm(&attr, ZB_MAC_ALG);
        if (psa_import_key(&attr, secret, sizeof(secret), &s_key) != PSA_SUCCESS) {
            ESP_LOGE(TAG, "message key import failed");
        }
    }

    // 셋업 모드에서도 스택은 띄워둔다(가입은 셋업 토큰을 받은 뒤). 그래야 공장 초기화 때
    // 이전 시도에서 남은 네트워크 정보까지 지울 수 있다.
    xTaskCreate(zb_main_task, "zb_main", 6144, NULL, 5, NULL);
}

// 일반 모드 생존 신호. 서버 응답의 registered=false면 공장 초기화(Wi-Fi 모델 /iot/ping과 같은 규칙).
// 첫 응답을 받으면 서버 init 완료로 보고 BLE 광고를 시작한다(Wi-Fi 모델 /iot/init 성공과 같은 시점).
static void zb_ping_task(void *arg)
{
    (void)arg;
    bool init_ok = false;
    for (;;) {
        zb_wait_joined(portMAX_DELAY);
        uint8_t body[1 + 4 + 2];
        body[0] = init_ok ? 0 : 0x01;
        uint32_t rnd = esp_random();
        memcpy(body + 1, &rnd, 4);
        uint16_t battery_mv = (uint16_t)battery_read_mv();
        memcpy(body + 5, &battery_mv, 2);
        zb_msg_t rsp;
        uint32_t delay_ms = ZB_PING_RETRY_MS;
        if (zb_request(ZB_MSG_PING, body, sizeof(body), ZB_MSG_PING_RESULT, &rsp, ZB_RSP_TIMEOUT_MS * 2) &&
            rsp.len >= 1) {
            if (rsp.data[0] == 0) {
                ESP_LOGW(TAG, "Device unregistered on server – factory reset");
                device_config_factory_reset();  // never returns
            }
            if (!init_ok) {
                ESP_LOGI(TAG, "Server init OK");
                init_ok = true;
                led_init_ok();
                ble_advertising_start();
            }
            ESP_LOGI(TAG, "Ping OK – next in 5 min");
            delay_ms = PING_INTERVAL_MS;
        } else {
            ESP_LOGW(TAG, "Ping: no server response – retry in 30s");
            if (!init_ok) led_init_fail();
        }
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(delay_ms));  // CHECK_REG를 받으면 바로 다음 ping
    }
}

void transport_start(void)
{
    led_wifi_connecting();  // "네트워크 연결 중" 패턴 공용
    zb_allow_steering();
    xTaskCreate(zb_ping_task, "zb_ping", 4096, NULL, 4, &s_ping_task);
}

typedef struct {
    uint8_t data[8 + 32];  // nonce + mac
} validate_args_t;

static void zb_validate_task(void *arg)
{
    validate_args_t *a = arg;
    zb_msg_t rsp;
    bool ok = zb_request(ZB_MSG_VALIDATE_TOKEN, a->data, sizeof(a->data),
                         ZB_MSG_AUTH_RESULT, &rsp, AUTH_TIMEOUT_MS) &&
              rsp.len >= 1 && rsp.data[0] == ZB_STATUS_OK;
    free(a);
    if (ok) {
        ESP_LOGI(TAG, "Token validation OK");
        led_notify_success();
        servo_activate();
        ble_server_disconnect();
    } else {
        ESP_LOGW(TAG, "Token validation failed");
        led_notify_fail();
    }
    vTaskDelete(NULL);
}

void transport_validate_token(const char *mac_hex, const char *nonce_hex)
{
    validate_args_t *a = malloc(sizeof(*a));
    if (!a) return;
    if (!hex_to_bytes(nonce_hex, a->data, 8) || !hex_to_bytes(mac_hex, a->data + 8, 32)) {
        ESP_LOGE(TAG, "validate: bad hex");
        free(a);
        led_notify_fail();
        return;
    }
    xTaskCreate(zb_validate_task, "zb_val", 4096, a, 5, NULL);
}

// 서버(server/mqtt_worker.py)와 같은 규칙으로 BLE UUID 4개를 만든다:
//   uuid_i = SHA256(seed || i)[0:16], 버전 4 · RFC 4122 variant 비트 설정 (Python uuid.UUID(bytes=..., version=4))
static bool derive_uuid(const uint8_t seed[16], uint8_t i, char out[CFG_UUID_LEN])
{
    uint8_t in[17], h[32];
    size_t  hl;
    memcpy(in, seed, 16);
    in[16] = i;
    if (psa_hash_compute(PSA_ALG_SHA_256, in, sizeof(in), h, sizeof(h), &hl) != PSA_SUCCESS) return false;
    h[6] = (h[6] & 0x0F) | 0x40;
    h[8] = (h[8] & 0x3F) | 0x80;
    snprintf(out, CFG_UUID_LEN,
             "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
             h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7],
             h[8], h[9], h[10], h[11], h[12], h[13], h[14], h[15]);
    return true;
}

// Step 6: {"setup_token":"..."}
bool transport_setup(const char *cred_json, void (*notify)(const char *msg))
{
    cJSON *root = cJSON_Parse(cred_json);
    cJSON *jtok = root ? cJSON_GetObjectItemCaseSensitive(root, "setup_token") : NULL;
    if (!cJSON_IsString(jtok) || strlen(jtok->valuestring) > ZB_MSG_MAX) {
        cJSON_Delete(root);
        ESP_LOGE(TAG, "Setup: invalid credentials JSON");
        return false;
    }
    char setup_token[ZB_MSG_MAX + 1];
    strlcpy(setup_token, jtok->valuestring, sizeof(setup_token));
    cJSON_Delete(root);

    notify("ACK");

    // Step 8: 게이트웨이 네트워크 가입 (앱이 셋업 토큰을 받을 때 서버가 permit join을 연다)
    zb_allow_steering();
    if (!zb_wait_joined(ZB_SETUP_JOIN_MS)) {
        ESP_LOGW(TAG, "Setup: no Zigbee network joined");
        notify("ZB_FAIL:JOIN");
        return true;
    }

    // Step 8: 서버 확인. 가입 직후엔 Z2M 인터뷰가 끝나기 전이라 메시지가 버려질 수 있어 응답이 올 때까지 다시 보낸다.
    // 서버 워커는 같은 (IEEE, setup_token) 재요청에 같은 결과를 돌려준다.
    zb_msg_t   rsp;
    bool       got = false;
    TickType_t until = xTaskGetTickCount() + pdMS_TO_TICKS(ZB_SETUP_SERVER_MS);
    while (!got && (int32_t)(until - xTaskGetTickCount()) > 0) {
        got = zb_request(ZB_MSG_VALIDATE_SETUP, setup_token, strlen(setup_token),
                         ZB_MSG_SETUP_RESULT, &rsp, ZB_RSP_TIMEOUT_MS);
        if (!got) vTaskDelay(pdMS_TO_TICKS(500));  // 송신 자체가 바로 실패하는 경우 바쁜 반복 방지
    }
    if (!got) {
        ESP_LOGW(TAG, "Setup: no server response");
        notify("ZB_FAIL:SERVER");
        return true;
    }
    if (rsp.len < 1 + 16 || rsp.data[0] != ZB_STATUS_OK) {
        ESP_LOGW(TAG, "Setup: token rejected (status %d)", rsp.len ? rsp.data[0] : -1);
        notify("TOKEN_FAIL");
        return true;
    }

    char svc[CFG_UUID_LEN], rd[CFG_UUID_LEN], wr[CFG_UUID_LEN], mfr[CFG_UUID_LEN];
    if (!derive_uuid(rsp.data + 1, 0, svc) || !derive_uuid(rsp.data + 1, 1, rd) ||
        !derive_uuid(rsp.data + 1, 2, wr) || !derive_uuid(rsp.data + 1, 3, mfr)) {
        ESP_LOGE(TAG, "Setup: UUID derivation failed");
        notify("TOKEN_FAIL");
        return true;
    }
    device_config_save_ble(svc, rd, wr, mfr);

    // Step 9~10
    notify("REGISTERED");
    vTaskDelay(pdMS_TO_TICKS(500));  // give notification time to deliver
    device_config_set_setup_complete(NULL, NULL);  // never returns
    return true;
}

void transport_notify_reset(void)
{
    if (!(xEventGroupGetBits(s_zb_eg) & ZB_JOINED_BIT)) return;
    zb_msg_t rsp;
    for (int i = 0; i < 2; i++) {
        if (zb_request(ZB_MSG_RESET, NULL, 0, ZB_MSG_RESET_RESULT, &rsp, 3000)) {
            ESP_LOGI(TAG, "reset acknowledged by server");
            return;
        }
    }
    ESP_LOGW(TAG, "reset: no server response");
}

void transport_factory_reset(void)
{
    // Zigbee 네트워크 정보까지 지우고 재시작한다(다음 셋업에서 다시 가입)
    esp_zigbee_lock_acquire(portMAX_DELAY);
    esp_zigbee_factory_reset();  // never returns
}
