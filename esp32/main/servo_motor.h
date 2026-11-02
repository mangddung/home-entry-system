#pragma once
#include <stdbool.h>

void servo_init(void);

// level: -1.0 (full low) … +1.0 (full high)
void servo_write(float level);

// Run the door-lock cycle: low → 1 s → high → 1 s → 펄스 끊기
void servo_activate(void);

// 대기 위치로 이동: high → 1 s → 펄스 끊기 (부팅 시)
void servo_rest(void);

// NVS-backed angle setpoints
float servo_get_low(void);
float servo_get_high(void);
void  servo_set_low(float level);
void  servo_set_high(float level);
