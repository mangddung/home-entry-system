#pragma once

// 셀 전압(mV)을 읽는다. 셀이 없거나 읽기에 실패하면 0. ping 태스크 하나에서만 호출한다.
int battery_read_mv(void);
