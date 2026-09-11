"""게스트 토큰 반복 사용 규칙(요일·시간대·회차별 횟수) 판정.

스케줄은 벽시계 규칙이므로 UTC로 환원할 수 없다. 발급 시점의 마스터 기기
타임존(IANA 문자열)을 함께 저장하고, 검증 시 UTC now를 그 타임존으로
변환해 판정한다.

화이트리스트: 매칭되는 창이 없으면 거부한다.
"""

from datetime import date, datetime, time, timedelta

DAY_NAMES = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
DAY_TAGS = set(DAY_NAMES) | {"weekday", "weekend"}

MAX_WINDOWS = 10


def day_tags(d: date) -> set[str]:
    """해당 날짜에 붙는 태그 집합."""
    return {DAY_NAMES[d.weekday()], "weekend" if d.weekday() >= 5 else "weekday"}


def _parse_hhmm(value):
    if not isinstance(value, str):
        return None
    parts = value.split(":")
    if len(parts) != 2:
        return None
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return time(hour, minute)


def validate_schedule(schedule):
    """발급 시 스케줄 형식 검증. (정규화된 스케줄, 에러메시지) 반환."""
    if not isinstance(schedule, dict):
        return None, "invalid schedule"

    windows = schedule.get("windows")
    if not isinstance(windows, list) or not windows:
        return None, "schedule requires at least one window"
    if len(windows) > MAX_WINDOWS:
        return None, "too many windows"

    seen_ids = set()
    normalized = []
    for w in windows:
        if not isinstance(w, dict):
            return None, "invalid window"

        try:
            wid = int(w.get("id"))
        except (TypeError, ValueError):
            return None, "invalid window id"
        if wid in seen_ids:
            return None, "duplicate window id"
        seen_ids.add(wid)

        days = w.get("days")
        if not isinstance(days, list) or not days:
            return None, "window requires days"
        if any(d not in DAY_TAGS for d in days):
            return None, "invalid day tag"

        if _parse_hhmm(w.get("start")) is None or _parse_hhmm(w.get("end")) is None:
            return None, "invalid window time"

        try:
            max_uses = int(w.get("max_uses"))
        except (TypeError, ValueError):
            return None, "invalid window max_uses"
        if max_uses < 1:
            return None, "invalid window max_uses"

        normalized.append({
            "id": wid,
            "days": list(dict.fromkeys(days)),
            "start": w["start"],
            "end": w["end"],
            "max_uses": max_uses,
        })

    if find_overlap(normalized):
        return None, "overlapping windows"

    return {"windows": normalized}, None


WEEK_MINUTES = 7 * 1440


def _expand_days(days):
    out = set()
    for d in days:
        if d == "weekday":
            out.update(DAY_NAMES[:5])
        elif d == "weekend":
            out.update(DAY_NAMES[5:])
        else:
            out.add(d)
    return out


def _week_intervals(window):
    """창을 주간 분 단위 [start, end) 구간 목록으로. 자정·주 경계를 넘으면 쪼갠다."""
    s_t, e_t = _parse_hhmm(window["start"]), _parse_hhmm(window["end"])
    s_min, e_min = s_t.hour * 60 + s_t.minute, e_t.hour * 60 + e_t.minute
    duration = (e_min - s_min) % 1440 or 1440   # end <= start면 익일까지(match_window와 동일)

    intervals = []
    for d in _expand_days(window["days"]):
        start = DAY_NAMES.index(d) * 1440 + s_min
        end = start + duration
        if end <= WEEK_MINUTES:
            intervals.append((start, end))
        else:  # 일요일 밤 → 월요일 새벽
            intervals.append((start, WEEK_MINUTES))
            intervals.append((0, end - WEEK_MINUTES))
    return intervals


def find_overlap(windows):
    """서로 다른 창끼리 시간이 겹치면 (창 id, 창 id), 없으면 None.

    겹치면 먼저 매칭된 창만 적용되고 뒤 창은 가려지므로 발급 시 막는다.
    """
    spans = [(w["id"], _week_intervals(w)) for w in windows]
    for i, (id_a, a) in enumerate(spans):
        for id_b, b in spans[i + 1:]:
            if any(sa < eb and sb < ea for sa, ea in a for sb, eb in b):
                return id_a, id_b
    return None


def match_window(schedule, local_dt: datetime):
    """현재 로컬 시각에 열려 있는 창을 찾는다. (창, 회차 시작 날짜) 또는 (None, None).

    end <= start면 자정을 넘긴 창으로 보고 익일까지 이어진다. 창 배열 순서가
    우선순위이며, 오늘 시작한 창을 어제 시작한 창보다 먼저 본다.
    """
    windows = (schedule or {}).get("windows") or []

    for offset in (0, 1):
        start_date = local_dt.date() - timedelta(days=offset)
        tags = day_tags(start_date)
        for w in windows:
            if not tags & set(w["days"]):
                continue
            start_t, end_t = _parse_hhmm(w["start"]), _parse_hhmm(w["end"])
            if start_t is None or end_t is None:
                continue
            start = datetime.combine(start_date, start_t, tzinfo=local_dt.tzinfo)
            end = datetime.combine(start_date, end_t, tzinfo=local_dt.tzinfo)
            if end <= start:
                end += timedelta(days=1)
            if start <= local_dt < end:
                return w, start_date
    return None, None


def windows_for_date(schedule, d: date):
    """해당 날짜에 시작하는 창 목록(오늘 회차 사용량 표시용)."""
    tags = day_tags(d)
    return [w for w in (schedule or {}).get("windows") or [] if tags & set(w["days"])]


def period_key(window, start_date: date) -> str:
    return f"{start_date.isoformat()}#{window['id']}"


def describe(schedule) -> str:
    """로그·디버그용 한 줄 요약."""
    windows = (schedule or {}).get("windows") or []
    return "; ".join(
        f"{'/'.join(w['days'])} {w['start']}-{w['end']} x{w['max_uses']}" for w in windows
    )
