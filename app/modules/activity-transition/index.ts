// N3 릴레이 완화: 걸음 센서로 마지막 걸음 시각을 재서 오래 정지 중이면 자동 해제를 막는다(tasks/bg-location.ts). Android 전용.
import { authLog } from "@/lib/auth-log";
import { appendSystemLog } from "@/lib/system-log";
import { requireOptionalNativeModule } from "expo";
import { PermissionsAndroid, Platform } from "react-native";

const native = requireOptionalNativeModule<{
  startStepWatch(): Promise<void>;
  getLastStepAt(): number | null;
  stopStepWatch(): Promise<void>;
  acquireWakeLock(timeoutMs: number): void;
  releaseWakeLock(): void;
  ensureTaskDelivery?(): Promise<boolean>;
  delay(id: number, ms: number): Promise<boolean>;
  cancelDelay(id: number): Promise<void>;
}>("ActivityTransition");

// 걸음 센서는 API 29+에서 신체 활동 권한이 있어야 값을 준다. 백그라운드에서는 물을 수 없어 앱 실행 때 요청한다.
export const requestActivityPermission = async () => {
  if (Platform.OS !== "android" || parseInt(Platform.Version.toString(), 10) < 29) return;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACTIVITY_RECOGNITION);
  if (result !== PermissionsAndroid.RESULTS.GRANTED) {
    appendSystemLog({ event_name: "ActivityTransition", log_type: "INFO", message: `permission ${result}` });
    authLog("ACTIVITY", `신체 활동 권한 ${result} → 걸음 센서 없이(정지 판정 없이) 동작`);
  }
};

// 걸음 센서는 켜져 있는 동안 걸은 것만 세므로 추적 루프 동안 켜 둔다. 포그라운드 서비스를 켠 뒤 부른다.
export const startStepWatch = async () => native?.startStepWatch();
export const stopStepWatch = async () => native?.stopStepWatch();

// 마지막 걸음 시각(epoch ms). 모르면(iOS·센서 없음·권한 거부·감시 전) null
export const getLastStepAt = (): number | null => native?.getLastStepAt() ?? null;

// 추적 루프 동안 CPU를 깨워 둔다(화면이 꺼지면 포그라운드 서비스만으로는 JS 타이머가 멈춘다). Android 전용.
export const acquireWakeLock = (timeoutMs: number) => native?.acquireWakeLock(timeoutMs);
export const releaseWakeLock = () => native?.releaseWakeLock();

// 백그라운드에서도 깨어나는 setTimeout. 앱을 열었다 백그라운드로 보내면 RN setTimeout이 포그라운드 서비스 중에도
// 멈춰서(실측) 추적 루프·BLE 대기는 이걸 쓴다. 네이티브 모듈이 없으면(iOS) 그냥 setTimeout.
let nextTimerId = 1;
export const setBgTimeout = (fn: () => void, ms: number): number => {
  if (!native) return setTimeout(fn, ms) as unknown as number;
  const id = nextTimerId++;
  void native.delay(id, ms).then((fired) => fired && fn());
  return id;
};
export const clearBgTimeout = (id: number) => {
  if (!native) clearTimeout(id);
  else void native.cancelDelay(id);
};
export const bgSleep = (ms: number) => new Promise<void>((resolve) => setBgTimeout(resolve, ms));

// expo-task-manager가 지운 태스크 수신 등록을 되살린다(이유는 네이티브 쪽 주석). 앱이 화면에 있을 때만 동작한다.
// 이 함수가 없는 예전 네이티브 빌드에서는 아무 일도 하지 않는다.
export const ensureTaskDelivery = () => {
  native?.ensureTaskDelivery?.().catch(() => {});
};
