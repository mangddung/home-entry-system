// N3 릴레이 완화: WALKING/STILL 전환을 감지해 오래 정지 중이면 자동 해제를 막는다(tasks/bg-location.ts).
// 전환은 튜닝용으로 시스템 로그에도 남는다. Android 전용.
import { appendSystemLog } from "@/lib/system-log";
import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";

const native = requireOptionalNativeModule<{
  start(): Promise<void>;
  getStillSince(): number | null;
}>("ActivityTransition");

export const startActivityTransitionLog = async () => {
  if (Platform.OS !== "android" || !native) return;
  if (parseInt(Platform.Version.toString(), 10) >= 29) {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      appendSystemLog({ event_name: "ActivityTransition", log_type: "INFO", message: `permission ${result}` });
      return;
    }
  }
  try {
    await native.start();
    appendSystemLog({ event_name: "ActivityTransition", log_type: "INFO", message: "registered (WALKING/STILL)" });
  } catch (e) {
    appendSystemLog({ event_name: "ActivityTransition", log_type: "ERROR", message: `register failed: ${e}` });
  }
};

// 마지막 STILL ENTER 시각(epoch ms). 정지 중이 아니거나 상태를 모르면(iOS·권한 거부·등록 전) null
export const getStillSince = (): number | null => native?.getStillSince() ?? null;
