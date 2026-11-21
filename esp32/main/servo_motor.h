#pragma once
#include <stdbool.h>

void servo_init(void);

// level: -1.0 (full low) … +1.0 (full high)
void servo_write(float level);

// Run the door-lock cycle: low → 1 s → high → 1 s → 펄스 끊기
void servo_activate(void);

// 대기 위치로 이동: high → 1 s → 펄스 끊기 (부팅 시)
void servo_rest(void);

// 실시간 조절: 0~180°로 바로 움직인다. NVS에 쓰지 않고, 입력이 멈추면 펄스를 끊는다.
// 다른 동작 중이면 버린다. NimBLE 호스트 태스크에서 호출해도 막히지 않는다.
void servo_preview_deg(int deg);

// NVS-backed angle setpoints
float servo_get_low(void);
float servo_get_high(void);
void  servo_set_low(float level);
void  servo_set_high(float level);

// 앱 설정 화면용 각도 단위(0~180°). low = 동작 각도, high = 대기 각도
void servo_get_range_deg(int *low_deg, int *high_deg);
void servo_set_range_deg(int low_deg, int high_deg);
