#pragma once
#include <stdint.h>

// ── Normal mode ───────────────────────────────────────────────────────────────
void ble_server_init(void);
void ble_advertising_start(void);  // iot/init 성공 후 호출
void ble_server_disconnect(void);  // 연결 종료 → disconnect 핸들러가 광고 재시작
void ble_server_clear_bonds(void); // NimBLE 페어링 키 전체 삭제 (Factory Reset 시 호출)
// 서버 검증 결과를 앱에 notify한다: "AUTH_OK" | "AUTH_DENY" | "AUTH_NET_FAIL".
// conn_gen은 요청을 보낸 연결의 세대다. 그사이 연결이 바뀌었으면 아무것도 하지 않는다.
// AUTH_OK는 알림이 나갈 시간을 기다린 뒤 연결을 끊으므로 검증 태스크(HTTP·Zigbee)에서 부른다.
void ble_server_auth_result(const char *code, uint32_t conn_gen);

// ── Setup mode ────────────────────────────────────────────────────────────────
// setup_done=false 부팅 시 호출; SETUP_SERVICE_UUID로 광고 시작
void ble_setup_server_init(void);
