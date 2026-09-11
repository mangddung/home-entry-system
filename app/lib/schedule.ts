// 게스트 토큰 스케줄을 앱에서 미리 판정한다. BLE 스캔을 시간대 밖에서 쉬게 하려는 용도이고,
// 최종 판정은 서버(server/app/utils/schedule.py)가 한다. 규칙은 서버와 같다:
// 창 배열 중 하나라도 열려 있으면 허용, end <= start면 익일까지, 회차는 시작일 기준.

export type ScheduleWindow = {
  id: number;
  days: string[];
  start: string;
  end: string;
  max_uses: number;
};

export type Schedule = { windows: ScheduleWindow[] };

type TokenLike = {
  not_before?: string | null;
  expired_at?: string | null;
  schedule?: Schedule | null;
  schedule_tz?: string | null;
};

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]; // Date.getUTCDay() 순서

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map((v) => parseInt(v, 10));
  return h * 60 + m;
};

// 스케줄 기준 시간대의 벽시계(날짜 + 자정 이후 분). 폰 시간대와 달라도 발급 시간대로 본다.
const wallClock = (now: Date, tz: string) => {
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now)) {
    parts[p.type] = p.value;
  }
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute), // 일부 엔진은 자정을 "24"로 준다
  };
};

const dayTags = (y: number, m: number, d: number) => {
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return new Set([dow, dow === "sat" || dow === "sun" ? "weekend" : "weekday"]);
};

export function isScheduleOpen(schedule: Schedule, tz: string, now = new Date()) {
  const { y, m, d, minutes } = wallClock(now, tz);
  // offset 1 = 어제 시작해 자정을 넘긴 창
  for (const offset of [0, 1]) {
    const tags = dayTags(y, m, d - offset);
    const t = minutes + offset * 1440;
    for (const w of schedule.windows) {
      if (!w.days.some((day) => tags.has(day))) continue;
      const s = toMinutes(w.start);
      const duration = (toMinutes(w.end) - s + 1440) % 1440 || 1440;
      if (s <= t && t < s + duration) return true;
    }
  }
  return false;
}

// 만료 전 토큰인지 (지오펜스 등록 여부 판단용)
export function isTokenAlive(token: TokenLike | null | undefined, now = new Date()) {
  if (!token?.expired_at) return false;
  return new Date(token.expired_at).getTime() > now.getTime();
}

// 지금 인증을 시도해볼 만한지 (BLE 스캔 여부 판단용)
export function isTokenUsableNow(token: TokenLike | null | undefined, now = new Date()) {
  if (!isTokenAlive(token, now)) return false;
  if (token!.not_before && new Date(token!.not_before).getTime() > now.getTime()) return false;
  if (token!.schedule && token!.schedule_tz) {
    return isScheduleOpen(token!.schedule, token!.schedule_tz, now);
  }
  return true;
}
