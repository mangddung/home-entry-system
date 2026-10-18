package expo.modules.activitytransition

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionResult
import com.google.android.gms.location.DetectedActivity
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

internal const val PREFS_NAME = "activity_transition"
internal const val KEY_STILL_SINCE = "still_since"

// lib/system-log.ts와 같은 파일·형식으로 남긴다. 앱 프로세스가 죽어 있어도 시스템이 깨워서 호출한다.
class ActivityTransitionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val result = ActivityTransitionResult.extractResult(intent) ?: return
    val fmt = SimpleDateFormat("yy-MM-dd HH:mm:ss", Locale.US)
    val now = System.currentTimeMillis()
    val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
    val lines = StringBuilder()
    for (e in result.transitionEvents) {
      // 이벤트 시각은 부팅 후 경과 시간이라 벽시계로 환산한다 (판정 시점 기준, 수신 시각과 0~3초 차이)
      val eventAt = now - (SystemClock.elapsedRealtimeNanos() - e.elapsedRealTimeNanos) / 1_000_000
      val still = e.activityType == DetectedActivity.STILL
      val enter = e.transitionType == ActivityTransition.ACTIVITY_TRANSITION_ENTER
      // 해제 판정용(tasks/bg-location.ts): STILL ENTER 시각을 남기고 EXIT면 지운다
      if (still) {
        if (enter) prefs.putLong(KEY_STILL_SINCE, eventAt) else prefs.remove(KEY_STILL_SINCE)
      }
      // 로그는 바뀐 상태만 (EXIT는 다음 ENTER와 짝이라 생략)
      if (enter) {
        lines.append("[${fmt.format(Date(now))}][INFO][ActivityTransition]: state ${if (still) "STILL" else "WALKING"}\n")
      }
    }
    // 리시버가 끝나면 프로세스가 바로 내려갈 수 있어 동기로 저장한다
    prefs.commit()
    if (lines.isEmpty()) return
    // ponytail: JS appendSystemLog는 파일 전체를 읽고 다시 쓰므로 그 사이에 끼면 이 줄이 유실될 수 있다. 판정은 prefs 기준이라 로그 유실만 감수
    File(context.filesDir, "system-logs.txt").appendText(lines.toString())
  }
}
