// lib/schedule.ts 자가 점검. 서버 tests/test_schedule.py와 같은 케이스.
// 실행: node --experimental-strip-types lib/schedule.check.ts  (RN 의존성 없음)
import assert from "node:assert/strict";
// @ts-ignore -- node --experimental-strip-types는 확장자가 있어야 해서 붙인다(앱 번들에는 포함되지 않는 파일)
import { isScheduleOpen, isTokenAlive, isTokenUsableNow } from "./schedule.ts";

const win = (id: number, days: string[], start: string, end: string) => ({
  id, days, start, end, max_uses: 1,
});
const KST = "Asia/Seoul";
// KST 벽시계 → 실제 순간 (KST는 DST 없음, UTC+9 고정)
const kst = (y: number, m: number, d: number, h: number, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h - 9, mi));

const s = { windows: [win(1, ["mon", "wed"], "09:00", "12:00")] };
assert.equal(isScheduleOpen(s, KST, kst(2026, 9, 14, 10)), true, "월 10시");
assert.equal(isScheduleOpen(s, KST, kst(2026, 9, 14, 13)), false, "창 밖");
assert.equal(isScheduleOpen(s, KST, kst(2026, 9, 15, 10)), false, "화요일");
assert.equal(isScheduleOpen(s, KST, kst(2026, 9, 14, 12)), false, "end 미포함");
assert.equal(isScheduleOpen(s, KST, kst(2026, 9, 14, 9)), true, "start 포함");

const weekend = { windows: [win(1, ["weekend"], "10:00", "20:00")] };
assert.equal(isScheduleOpen(weekend, KST, kst(2026, 9, 19, 11)), true, "토 (태그)");
assert.equal(isScheduleOpen(weekend, KST, kst(2026, 9, 18, 11)), false, "금 (태그)");

const night = { windows: [win(1, ["mon"], "22:00", "02:00")] };
assert.equal(isScheduleOpen(night, KST, kst(2026, 9, 14, 23)), true, "월 23시");
assert.equal(isScheduleOpen(night, KST, kst(2026, 9, 15, 1)), true, "화 01시 = 월 회차");
assert.equal(isScheduleOpen(night, KST, kst(2026, 9, 15, 3)), false, "화 03시");

const sunNight = { windows: [win(1, ["sun"], "23:00", "02:00")] };
assert.equal(isScheduleOpen(sunNight, KST, kst(2026, 9, 21, 1)), true, "월 01시 = 일 회차(주 경계)");

// 폰 시간대와 무관하게 발급 시간대로 판정: 같은 순간을 UTC 규칙으로 보면 결과가 다르다
assert.equal(isScheduleOpen(s, "UTC", kst(2026, 9, 14, 10)), false, "UTC 기준이면 월 01시라 창 밖");

const now = kst(2026, 9, 14, 10);
const future = new Date(now.getTime() + 3600_000).toISOString();
const past = new Date(now.getTime() - 3600_000).toISOString();
assert.equal(isTokenAlive({ expired_at: future }, now), true);
assert.equal(isTokenAlive({ expired_at: past }, now), false);
assert.equal(isTokenAlive(null, now), false);
assert.equal(isTokenUsableNow({ expired_at: future, not_before: future }, now), false, "not_before 전");
assert.equal(isTokenUsableNow({ expired_at: future, schedule: s, schedule_tz: KST }, now), true);
assert.equal(
  isTokenUsableNow({ expired_at: future, schedule: s, schedule_tz: KST }, kst(2026, 9, 14, 13)),
  false,
  "스케줄 밖",
);

console.log("schedule.check: all ok");
