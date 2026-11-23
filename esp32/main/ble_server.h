#pragma once

// ── Normal mode ───────────────────────────────────────────────────────────────
void ble_server_init(void);
void ble_advertising_start(void);  // iot/init 성공 후 호출
void ble_server_disconnect(void);  // 연결 종료 → disconnect 핸들러가 광고 재시작
void ble_server_clear_bonds(void); // NimBLE 페어링 키 전체 삭제 (Factory Reset 시 호출)
// 서버 검증 결과를 앱에 notify한다: "AUTH_OK" | "AUTH_DENY" | "AUTH_NET_FAIL".
// 검증 태스크(HTTP·Zigbee)에서만 부른다. AUTH_OK는 알림이 나갈 시간을 기다린 뒤 연결을 끊는다.
void ble_server_auth_result(const char *code);

// ── Setup mode ────────────────────────────────────────────────────────────────
// setup_done=false 부팅 시 호출; SETUP_SERVICE_UUID로 광고 시작
void ble_setup_server_init(void);
