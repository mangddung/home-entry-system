package expo.modules.activitytransition

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener2
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val PREFS_NAME = "activity_transition"
private const val KEY_STEPS = "steps"
private const val KEY_LAST_STEP_AT = "last_step_at"
private const val FLUSH_TIMEOUT_MS = 2000L

// N3 릴레이 완화용 정지 판정(tasks/bg-location.ts). 하드웨어 걸음 센서(TYPE_STEP_COUNTER)로 마지막 걸음 시각을 잰다.
// Play Services 활동 전환(Transition API)은 기기마다 판정이 늦거나 오지 않아(S10 무응답, S24 STILL 고착) 걸음 센서로 바꿨다.
// 걸음 센서는 켜져 있는 동안 걸은 것만 센다(AOSP sensor-types). 잠깐 켜서 읽고 끄면 그 사이 걸음이 빠지므로
// 추적 루프 동안 켜 둔다(startStepWatch ~ stopStepWatch).
class ActivityTransitionModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  @Volatile private var watch: SensorEventListener2? = null
  // 이번 감시에서 받은 마지막 걸음 시각(epoch ms). 아직 센서 응답이 없으면 null
  @Volatile private var lastStepAt: Long? = null

  private val sensorManager: SensorManager?
    get() = appContext.reactContext?.getSystemService(Context.SENSOR_SERVICE) as SensorManager?

  private fun stopWatch() {
    watch?.let { sensorManager?.unregisterListener(it) }
    watch = null
    lastStepAt = null
  }

  override fun definition() = ModuleDefinition {
    Name("ActivityTransition")

    // 걸음 센서를 켜고, 하드웨어에 쌓여 있던 걸음까지 받은 뒤(최대 2초) 끝난다. 이미 켜져 있으면 바로 끝난다.
    // 백그라운드 앱은 센서 이벤트를 받지 못하므로(Android 9+) 포그라운드 서비스를 켠 뒤 부른다.
    AsyncFunction("startStepWatch") { promise: Promise ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val sm = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
      val sensor = sm.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
      if (sensor == null || watch != null) {
        promise.resolve(null)
      } else {
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        var settled = false
        var flushing = false
        val settle = {
          if (!settled) {
            settled = true
            promise.resolve(null)
          }
        }
        val listener = object : SensorEventListener2 {
          override fun onSensorChanged(e: SensorEvent) {
            val steps = e.values[0].toLong()
            // 이벤트 시각(부팅 후 경과)은 이 이벤트의 마지막 걸음 시각이다. 벽시계로 환산한다
            val fromEvent = System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - e.timestamp) / 1_000_000
            // 걸음 수가 지난번과 같으면 그때 기록한 시각을 쓴다(켜는 즉시 오는 이벤트는 켠 시각을 줄 수 있다).
            // 재부팅하면 걸음 수가 0부터 다시 세므로 달라진다
            val at = if (prefs.getLong(KEY_STEPS, -1L) == steps) prefs.getLong(KEY_LAST_STEP_AT, fromEvent) else fromEvent
            prefs.edit().putLong(KEY_STEPS, steps).putLong(KEY_LAST_STEP_AT, at).apply()
            lastStepAt = at
            if (!flushing) settle()
          }

          override fun onFlushCompleted(sensor: Sensor) = settle()

          override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {}
        }
        // 보고 지연 0: 다른 앱(삼성 헬스 등)이 묶음 전달로 켜 둔 센서도 걸음마다 바로 받는다.
        // 메인 큐에서 돌아서 아래 상태를 다 정한 뒤에야 콜백이 실행된다
        if (sm.registerListener(listener, sensor, SensorManager.SENSOR_DELAY_NORMAL, 0, handler)) {
          watch = listener
          // 다른 앱이 켜 둔 센서는 등록 즉시 예전 값을 준다. 하드웨어에 쌓인 걸음을 비워 받은 뒤 끝낸다
          flushing = sm.flush(listener)
          handler.postDelayed({ settle() }, FLUSH_TIMEOUT_MS)
        } else {
          settle()
        }
      }
    }.runOnQueue(Queues.MAIN)

    // 마지막 걸음 시각(epoch ms). 감시 중이 아니거나 아직 센서 응답이 없으면 null.
    // 화면이 꺼져 있으면 걸음이 하드웨어에 쌓여만 있으므로 읽을 때마다 비우게 해서 다음 읽기에 반영한다
    Function("getLastStepAt") {
      watch?.let { sensorManager?.flush(it) }
      lastStepAt?.toDouble()
    }

    AsyncFunction("stopStepWatch") { stopWatch() }.runOnQueue(Queues.MAIN)

    OnDestroy { stopWatch() }
  }
}
