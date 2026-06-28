#pragma once

// ── Normal mode ───────────────────────────────────────────────────────────────
void ble_server_init(void);
void ble_advertising_start(void);  // iot/init 성공 후 호출
void ble_server_disconnect(void);  // 연결 종료 → disconnect 핸들러가 광고 재시작
void ble_server_clear_bonds(void); // NimBLE 페어링 키 전체 삭제 (Factory Reset 시 호출)

// ── Setup mode ────────────────────────────────────────────────────────────────
// setup_done=false 부팅 시 호출; SETUP_SERVICE_UUID로 광고 시작
void ble_setup_server_init(void);
