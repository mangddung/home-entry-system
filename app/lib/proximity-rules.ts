// 근접 해제(계획서 4.11) 판정·보정 규칙. RN 의존성 없음 → proximity-rules.check.ts로 node에서 점검.
// 아래 값은 실측 후 조정하는 손잡이다.

export const GATE_WINDOW = 5; // 이동 중앙값 창(샘플 수). RSSI는 ±5~10dB 흔들린다
export const GATE_HITS = 3; // 중앙값이 문턱 이상인 연속 횟수
export const STEP_DB = 2; // 피드백 1회 반영 폭
export const STREAK_TO_APPLY = 2; // 같은 방향 피드백이 이만큼 연속이어야 반영
export const CLAMP_DB = 10; // ref_rssi 기준 조정 한도
export const FEEDBACK_MATCH_MS = 30_000; // 자동 트리거 후 이 안에 성공 푸시가 오면 피드백 대상
export const FEEDBACK_TTL_MS = 3 * 60 * 60 * 1000; // 피드백 가능 시간(해제 시각 기준)
export const IMPLICIT_LATE_MS = 5 * 60 * 1000; // 진입 후 이 안에 수동 인증하면 "늦음"으로 간주

export type Calibration = {
  ref_rssi: number; // 기준점에서 잰 내 RSSI 중앙값(dBm)
  adjust_db: number; // 피드백 누적 조정(±CLAMP_DB)
  streak: number; // +n: early 연속, -n: late 연속
};

export type FeedbackAnswer = "early" | "ok" | "late";
export const ANSWER_LABEL: Record<FeedbackAnswer, string> = { early: "일찍", ok: "적당", late: "늦게" };

export type FeedbackRecord = {
  id: string;
  device_uuid: string;
  trigger_rssi: number | null; // 암묵 신호는 트리거가 없어 null
  threshold: number;
  at: number; // 해제(트리거) 시각 ms
  status: "pending" | "done";
  answer?: FeedbackAnswer;
  source?: "notification" | "app" | "implicit";
};

export const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

// 보정했으면 내 기준, 아니면 마스터가 정한 기기 임계값. 둘 다 없으면 null(첫 발견 즉시 연결).
export const effectiveThreshold = (cal: Calibration | undefined, deviceThreshold: number | null | undefined) =>
  cal ? cal.ref_rssi + cal.adjust_db : (deviceThreshold ?? null);

// 광고 RSSI를 하나씩 넣으면, 문턱을 넘었다고 판정된 순간의 중앙값을 돌려준다(아니면 null).
export function createGate(threshold: number) {
  const samples: number[] = [];
  let hits = 0;
  return (rssi: number): number | null => {
    samples.push(rssi);
    if (samples.length > GATE_WINDOW) samples.shift();
    const m = median(samples);
    hits = m >= threshold ? hits + 1 : 0;
    return hits >= GATE_HITS ? m : null;
  };
}

// early(너무 멀리서 열림) → 문턱을 올린다(+), late → 내린다(-). 같은 방향 연속일 때만 한 칸.
export function applyAnswer(cal: Calibration, answer: FeedbackAnswer): Calibration {
  if (answer === "ok") return { ...cal, streak: 0 };
  const dir = answer === "early" ? 1 : -1;
  const streak = Math.sign(cal.streak) === dir ? cal.streak + dir : dir;
  if (Math.abs(streak) < STREAK_TO_APPLY) return { ...cal, streak };
  const adjust_db = Math.max(-CLAMP_DB, Math.min(CLAMP_DB, cal.adjust_db + dir * STEP_DB));
  return { ...cal, adjust_db, streak: 0 };
}

// 저장된 status에 만료를 덧씌운다(만료는 저장하지 않고 읽을 때 계산).
export const feedbackStatus = (rec: FeedbackRecord, now = Date.now()) =>
  rec.status === "pending" && now - rec.at > FEEDBACK_TTL_MS ? "expired" : rec.status;
