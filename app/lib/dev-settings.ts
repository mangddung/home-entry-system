// 개발자 도구의 디버그 설정. 백그라운드(지오펜스·추적 루프)에서도 읽으므로 AsyncStorage에 둔다.
// 매번 읽어서 쓰기 때문에 바꾸면 진행 중인 추적 루프에도 다음 회차부터 바로 반영된다.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { GEOFENCE_RADIUS_M } from "./constants";

const KEY = "dev-settings";

// Android 지오펜스는 100m 미만을 신뢰성 있게 판정하지 못한다(constants.ts 참고)
export const GEOFENCE_RADIUS_OPTIONS = [100, 150, 200, 300, 500] as const;

export type DevSettings = {
  geofenceRadiusM: number; // 지오펜스 반경. 바꾸면 updateGeoFence로 재등록해야 반영된다
  geofenceNotify: boolean; // 진입·이탈 알림
  geofenceLocationLog: boolean; // 진입·이탈 위치를 GPS 탭에 기록
  stillCheck: boolean; // 오래 정지 중이면 자동 해제 보류(N3 릴레이 완화)
  stillHeartbeat: boolean; // 정지 대기 중 1분마다 진단 로그
  rssiGate: boolean; // 근접 문턱(RSSI) 사용. 끄면 발견 즉시 연결
  wakeLock: boolean; // 추적 중 CPU 유지
};

export const DEV_SETTING_DEFAULTS: DevSettings = {
  geofenceRadiusM: GEOFENCE_RADIUS_M,
  geofenceNotify: true,
  geofenceLocationLog: true,
  stillCheck: true,
  stillHeartbeat: true,
  rssiGate: true,
  wakeLock: true,
};

export const getDevSettings = async (): Promise<DevSettings> => {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return { ...DEV_SETTING_DEFAULTS, ...(raw ? JSON.parse(raw) : {}) };
  } catch {
    return DEV_SETTING_DEFAULTS;
  }
};

export const setDevSetting = async <K extends keyof DevSettings>(key: K, value: DevSettings[K]) => {
  await AsyncStorage.setItem(KEY, JSON.stringify({ ...(await getDevSettings()), [key]: value }));
};
