#pragma once
#include <stdbool.h>
#include <stdint.h>
#include "sdkconfig.h"

// 서버 통신 경로. 모델(Kconfig DOORLOCK_TRANSPORT_*)마다 구현 하나만 빌드된다.
//   Wi-Fi:  transport_wifi.c   (HTTP 직접, http_api.c 사용)
//   Zigbee: transport_zigbee.c (Zigbee → 게이트웨이 → MQTT → 서버)

// 광고 manufacturer data에 싣는 모델 코드. 앱 스캔 목록이 연결 전에 모델 아이콘을 고른다.
#if CONFIG_DOORLOCK_TRANSPORT_ZIGBEE
#define TRANSPORT_IS_ZIGBEE  1
#define TRANSPORT_MODEL_CODE 2
#else
#define TRANSPORT_IS_ZIGBEE  0
#define TRANSPORT_MODEL_CODE 1
#endif

// app_main 초기에 한 번 (셋업·일반 모드 공통)
void transport_init(void);

// 일반 모드: 네트워크 연결 → 서버 init(성공 시 BLE 광고 시작) → 주기 생존 신호
void transport_start(void);

// 근접 열기 인증 요청(비동기). 결과에 따라 LED·서보·BLE 연결 끊기까지 처리한다.
// conn_gen: 요청을 보낸 BLE 연결의 세대. 결과 알림은 그 연결에만 간다(ble_server_auth_result).
void transport_validate_token(const char *mac_hex, const char *nonce_hex, uint32_t conn_gen);

// 셋업 Step 6~9: 앱이 보낸 자격 JSON으로 네트워크 연결 + 서버 등록 확인(동기, 셋업 태스크에서 호출).
// 진행 상황은 notify로 앱에 보낸다(ACK, 실패 코드, REGISTERED).
// 성공하면 설정을 저장하고 재부팅한다(반환하지 않음).
// 반환: true = 실패 코드를 알렸으니 재시도 대기, false = 잘못된 페이로드라 흐름 중단.
bool transport_setup(const char *cred_json, void (*notify)(const char *msg));

// 공장 초기화 직전 서버 알림(동기, 실패해도 반환)
void transport_notify_reset(void);

// 공장 초기화 마지막 단계: 모델별 네트워크 정보까지 지우고 재시작(반환하지 않음).
// Wi-Fi: 재시작만(자격증명은 device_config가 지움) / Zigbee: Zigbee 네트워크 정보 삭제 후 재시작
void transport_factory_reset(void);
