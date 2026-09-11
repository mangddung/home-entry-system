"""게스트 토큰 스케줄 판정 단위 테스트. DB·네트워크 없음."""
import sys, pathlib
from datetime import datetime, date
from zoneinfo import ZoneInfo

SERVER = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))

from app.utils.schedule import day_tags, validate_schedule, match_window, period_key

KST = ZoneInfo("Asia/Seoul")


def sched(*windows):
    return {"windows": list(windows)}


def win(wid, days, start, end, max_uses=1):
    return {"id": wid, "days": days, "start": start, "end": end, "max_uses": max_uses}


# --- day_tags ---
assert day_tags(date(2026, 9, 14)) == {"mon", "weekday"}      # 월
assert day_tags(date(2026, 9, 19)) == {"sat", "weekend"}      # 토

# --- validate_schedule ---
ok, err = validate_schedule(sched(win(1, ["mon"], "09:00", "12:00", 2)))
assert err is None and ok["windows"][0]["max_uses"] == 2

for bad, why in (
    ({"windows": []}, "빈 배열은 전면 차단이라 거부"),
    ({"windows": [win(1, [], "09:00", "12:00")]}, "요일 없음"),
    ({"windows": [win(1, ["funday"], "09:00", "12:00")]}, "알 수 없는 태그"),
    ({"windows": [win(1, ["mon"], "9:00:00", "12:00")]}, "시각 형식"),
    ({"windows": [win(1, ["mon"], "25:00", "12:00")]}, "시각 범위"),
    ({"windows": [win(1, ["mon"], "09:00", "12:00", 0)]}, "횟수 0"),
    ({"windows": [win(1, ["mon"], "09:00", "12:00"), win(1, ["tue"], "09:00", "12:00")]}, "id 중복"),
    ("nope", "형식"),
):
    got, e = validate_schedule(bad)
    assert got is None and e, why

# --- match_window: 기본 ---
s = sched(win(1, ["mon", "wed"], "09:00", "12:00", 2))
w, d = match_window(s, datetime(2026, 9, 14, 10, 0, tzinfo=KST))   # 월 10시
assert w["id"] == 1 and d == date(2026, 9, 14)
assert match_window(s, datetime(2026, 9, 14, 13, 0, tzinfo=KST))[0] is None   # 창 밖
assert match_window(s, datetime(2026, 9, 15, 10, 0, tzinfo=KST))[0] is None   # 화요일
assert match_window(s, datetime(2026, 9, 14, 12, 0, tzinfo=KST))[0] is None   # end는 미포함
assert match_window(s, datetime(2026, 9, 14, 9, 0, tzinfo=KST))[0] is not None  # start는 포함

# --- 요일별 다른 시간대 ---
s2 = sched(win(1, ["mon"], "09:00", "12:00"), win(2, ["fri"], "18:00", "23:00"))
assert match_window(s2, datetime(2026, 9, 18, 19, 0, tzinfo=KST))[0]["id"] == 2   # 금 19시
assert match_window(s2, datetime(2026, 9, 18, 10, 0, tzinfo=KST))[0] is None      # 금 10시

# --- 프리셋 태그 ---
s3 = sched(win(1, ["weekend"], "10:00", "20:00", 3))
assert match_window(s3, datetime(2026, 9, 19, 11, 0, tzinfo=KST))[0]["id"] == 1   # 토
assert match_window(s3, datetime(2026, 9, 18, 11, 0, tzinfo=KST))[0] is None      # 금

# --- 우선순위: 배열 순서 (앞선 창이 이긴다) ---
s4 = sched(win(1, ["mon"], "09:00", "18:00", 5), win(2, ["weekday"], "09:00", "18:00", 1))
assert match_window(s4, datetime(2026, 9, 14, 10, 0, tzinfo=KST))[0]["id"] == 1

# --- 자정 넘김 ---
s5 = sched(win(1, ["mon"], "22:00", "02:00"))
assert match_window(s5, datetime(2026, 9, 14, 23, 0, tzinfo=KST))[0] is not None   # 월 23시
w, d = match_window(s5, datetime(2026, 9, 15, 1, 0, tzinfo=KST))                   # 화 01시
assert w is not None and d == date(2026, 9, 14), "회차는 시작일(월) 기준"
assert match_window(s5, datetime(2026, 9, 15, 3, 0, tzinfo=KST))[0] is None        # 화 03시

# --- 회차 키가 주마다 바뀐다(= 사용 횟수 리셋) ---
w1, d1 = match_window(s, datetime(2026, 9, 14, 10, 0, tzinfo=KST))
w2, d2 = match_window(s, datetime(2026, 9, 21, 10, 0, tzinfo=KST))
assert period_key(w1, d1) != period_key(w2, d2)
assert period_key(w1, d1) == "2026-09-14#1"

# --- 타임존이 판정을 바꾼다 ---
# KST 월 10:00 = UTC 일 01:00 -> UTC로 보면 월요일 창에 안 걸린다
utc_dt = datetime(2026, 9, 14, 10, 0, tzinfo=KST).astimezone(ZoneInfo("UTC"))
assert match_window(s, utc_dt.astimezone(KST))[0] is not None
assert match_window(s, utc_dt.replace(tzinfo=ZoneInfo("UTC")))[0] is None

# --- DST 경계 (New York, 2026-03-08 02:00 건너뜀) ---
NY = ZoneInfo("America/New_York")
s6 = sched(win(1, ["sun"], "01:30", "03:30"))
assert match_window(s6, datetime(2026, 3, 8, 3, 0, tzinfo=NY))[0] is not None

# --- 겹침 금지 ---
from app.utils.schedule import find_overlap

def overlaps(*windows):
    return find_overlap(list(windows)) is not None

assert overlaps(win(1, ["weekday"], "09:00", "18:00"), win(2, ["mon"], "12:00", "14:00")), "프리셋 태그 확장"
assert overlaps(win(1, ["mon"], "22:00", "02:00"), win(2, ["tue"], "01:00", "03:00")), "자정 넘김"
assert overlaps(win(1, ["sun"], "23:00", "02:00"), win(2, ["mon"], "01:00", "03:00")), "주 경계(일→월)"
assert overlaps(win(1, ["mon"], "10:00", "10:00"), win(2, ["mon"], "15:00", "16:00")), "start==end는 24시간"
assert not overlaps(win(1, ["mon"], "09:00", "12:00"), win(2, ["mon"], "12:00", "14:00")), "경계만 닿음"
assert not overlaps(win(1, ["mon"], "09:00", "18:00"), win(2, ["tue"], "09:00", "18:00")), "다른 요일"
assert not overlaps(win(1, ["mon", "tue"], "22:00", "02:00")), "한 창 안의 요일끼리는 검사 안 함"

got, e = validate_schedule(sched(win(1, ["weekday"], "09:00", "18:00"), win(2, ["mon"], "12:00", "14:00", 3)))
assert got is None and e == "overlapping windows"

# --- 오늘 시작하는 창 (오늘 사용량 표시) ---
from app.utils.schedule import windows_for_date
s7 = sched(win(1, ["weekday"], "09:00", "12:00", 2), win(2, ["mon"], "14:00", "16:00", 3), win(3, ["sat"], "10:00", "12:00"))
assert [w["id"] for w in windows_for_date(s7, date(2026, 9, 14))] == [1, 2]   # 월
assert [w["id"] for w in windows_for_date(s7, date(2026, 9, 15))] == [1]      # 화
assert [w["id"] for w in windows_for_date(s7, date(2026, 9, 20))] == []       # 일

print("test_schedule: all ok")
