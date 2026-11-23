#pragma once
#include <stdint.h>

// POST /api/iot/init – register device UUIDs with Home Assistant
void http_fetch_iot_init(void);

// POST /api/iot/validate_token – verify OTP / ciphertext with HA
// All strings must remain valid for the duration of the call.
// conn_gen: 요청한 BLE 연결의 세대. 결과는 ble_server_auth_result로 그 연결에만 알린다.
void http_request_validate_token(const char *encrypted_token,
                                  const char *nonce, uint32_t conn_gen);

// POST /iot/ping – 5분 간격 heartbeat (500 응답 시 30초로 전환)
// WiFi 연결 직후 한 번만 호출; 내부적으로 영구 루프 태스크를 생성
void http_start_ping_task(void);

// POST /iot/validate_setup – 초기 설정 시 setup_token 검증 (동기, 태스크 내에서 호출)
// Authorization 헤더에 g_cfg.device_token 포함
// 성공(200) 시 응답의 device_token을 NVS에 저장
// 반환값: HTTP 상태 코드 (200=성공, 4xx=토큰 불일치, 0=네트워크 오류)
int http_validate_setup(const char *setup_token);

// POST /iot/reset – 공장 초기화 직전 서버에 알림 (동기, 2회 시도 후 반환)
void http_notify_reset(void);
