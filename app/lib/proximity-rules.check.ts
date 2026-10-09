// lib/proximity-rules.ts 자가 점검.
// 실행: node --experimental-strip-types lib/proximity-rules.check.ts  (RN 의존성 없음)
import assert from "node:assert/strict";
// @ts-ignore -- node --experimental-strip-types는 확장자가 있어야 해서 붙인다(앱 번들에는 포함되지 않는 파일)
import { applyAnswer, CLAMP_DB, createGate, effectiveThreshold, FEEDBACK_TTL_MS, feedbackStatus, median } from "./proximity-rules.ts";

assert.equal(median([-70, -60, -80]), -70);
assert.equal(median([-70, -60]), -65);

// 문턱: 보정값 우선, 없으면 기기 임계값, 둘 다 없으면 null
assert.equal(effectiveThreshold({ ref_rssi: -70, adjust_db: 4, streak: 0 }, -60), -66);
assert.equal(effectiveThreshold(undefined, -60), -60);
assert.equal(effectiveThreshold(undefined, null), null);

// 게이트: 중앙값이 문턱 이상 3회 연속이어야 트리거, 튀는 값 하나로는 안 열린다
{
  const gate = createGate(-65);
  assert.equal(gate(-80), null);
  assert.equal(gate(-50), null); // 튐: 중앙값 -65 → hit 1
  assert.equal(gate(-80), null); // 중앙값 -80 → 리셋
  assert.equal(gate(-60), null); // [-80,-50,-80,-60] 중앙값 -70
  assert.equal(gate(-60), null); // [-80,-50,-80,-60,-60] -60 → hit 1
  assert.equal(gate(-58), null); // [-50,-80,-60,-60,-58] -60 → hit 2
  assert.equal(gate(-57), -60); // [-80,-60,-60,-58,-57] -60 → hit 3, 트리거(중앙값 반환)
}

// 피드백: 같은 방향 2회 연속일 때만 2dB, ok는 연속 리셋
{
  let c = { ref_rssi: -70, adjust_db: 0, streak: 0 };
  c = applyAnswer(c, "late");
  assert.deepEqual(c, { ref_rssi: -70, adjust_db: 0, streak: -1 });
  c = applyAnswer(c, "late");
  assert.deepEqual(c, { ref_rssi: -70, adjust_db: -2, streak: 0 }); // 늦음 → 문턱 내림(더 멀리서)
  c = applyAnswer(c, "early");
  c = applyAnswer(c, "ok");
  c = applyAnswer(c, "early");
  assert.equal(c.adjust_db, -2, "ok가 끼면 연속이 끊긴다");
  c = applyAnswer(c, "early");
  assert.equal(c.adjust_db, 0); // 이름 → 문턱 올림
  c = applyAnswer(c, "late");
  c = applyAnswer(c, "early");
  assert.equal(c.streak, 1, "방향이 바뀌면 새로 센다");
  for (let i = 0; i < 40; i++) c = applyAnswer(c, "late");
  assert.equal(c.adjust_db, -CLAMP_DB, "하한 클램프");
  for (let i = 0; i < 40; i++) c = applyAnswer(c, "early");
  assert.equal(c.adjust_db, CLAMP_DB, "상한 클램프");
}

// 만료는 pending에만, 3시간 기준
{
  const rec = { id: "a", device_uuid: "d", trigger_rssi: -60, threshold: -62, at: 0, status: "pending" as const };
  assert.equal(feedbackStatus(rec, FEEDBACK_TTL_MS), "pending");
  assert.equal(feedbackStatus(rec, FEEDBACK_TTL_MS + 1), "expired");
  assert.equal(feedbackStatus({ ...rec, status: "done" }, FEEDBACK_TTL_MS + 1), "done");
}

console.log("proximity-rules: 전체 통과");
