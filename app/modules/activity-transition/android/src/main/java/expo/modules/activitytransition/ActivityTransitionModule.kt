package expo.modules.activitytransition

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.google.android.gms.location.ActivityRecognition
import com.google.android.gms.location.ActivityTransition
import com.google.android.gms.location.ActivityTransitionRequest
import com.google.android.gms.location.DetectedActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ActivityTransitionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ActivityTransition")

    // 같은 PendingIntent로 다시 요청하면 기존 등록을 대체한다.
    // 재부팅하면 등록이 사라지므로 앱 실행마다 호출한다.
    AsyncFunction("start") { promise: Promise ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val transitions = listOf(DetectedActivity.WALKING, DetectedActivity.STILL).flatMap { type ->
        listOf(ActivityTransition.ACTIVITY_TRANSITION_ENTER, ActivityTransition.ACTIVITY_TRANSITION_EXIT).map { transition ->
          ActivityTransition.Builder().setActivityType(type).setActivityTransition(transition).build()
        }
      }
      try {
        ActivityRecognition.getClient(context)
          .requestActivityTransitionUpdates(ActivityTransitionRequest(transitions), pendingIntent(context))
          .addOnSuccessListener { promise.resolve(null) }
          .addOnFailureListener { e -> promise.reject("ERR_ACTIVITY_TRANSITION", e.message, e) }
      } catch (e: SecurityException) {
        promise.reject("ERR_ACTIVITY_TRANSITION_PERMISSION", e.message, e)
      }
    }

    // 마지막 STILL ENTER 시각(epoch ms). STILL이 아니거나 아직 전환을 받은 적 없으면 null
    Function("getStillSince") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
      if (prefs.contains(KEY_STILL_SINCE)) prefs.getLong(KEY_STILL_SINCE, 0L) else null
    }
  }

  private fun pendingIntent(context: Context): PendingIntent {
    // Play Services가 결과를 extras로 채워 넣으므로 Android 12+에서는 MUTABLE이어야 한다
    val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
    return PendingIntent.getBroadcast(
      context,
      0,
      Intent(context, ActivityTransitionReceiver::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or mutable,
    )
  }
}
