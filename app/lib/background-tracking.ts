// 등록된 기기 위치마다 고정 반경(GEOFENCE_RADIUS_M, 디버그 설정에서 조절) geofence를 걸고,
// 진입 이벤트가 오면 BLE 스캔으로 실제 근접 판정을 넘긴다.

import notifee, { AndroidForegroundServiceType, AndroidImportance, type Notification } from "@notifee/react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { AppState } from "react-native";
import { loadDevices } from "./api/devices";
import {
  BG_GEOFENCE_TASK,
  BG_LOCATION_TASK,
} from "./constants";
import { authLog, short } from "./auth-log";
import { acquireWakeLock, bgSleep, releaseWakeLock } from "@/modules/activity-transition";
import { getDevSettings } from "./dev-settings";
import { appendSystemLog } from "./system-log";
import { IoTDevice } from "./types";

// 기존 GPS 폴링 + haversine 거리계산 방식 (native geofence로 대체, 주석 처리)
// ================================================================================
// const getDistancem = (lat1: number, lon1: number, lat2: number, lon2: number) => {
//   if (lat1 == lat2 && lon1 == lon2) return 0;
//   const R = 6371;
//   const dLat = ((lat2 - lat1) * Math.PI) / 180;
//   const dLon = ((lon2 - lon1) * Math.PI) / 180;
//   const a =
//     Math.sin(dLat / 2) * Math.sin(dLat / 2) +
//     Math.cos((lat1 * Math.PI) / 180) *
//       Math.cos((lat2 * Math.PI) / 180) *
//       Math.sin(dLon / 2) *
//       Math.sin(dLon / 2);
//   const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
//   return R * c * 1000;
// };

// export const updateDeviceStatus = async (location: Location) => {
//   const devices: IoTDevice[] = await loadDevices();
//   const validDevices = devices.filter(
//     (device) =>
//       device.location &&
//       device.location.latitude !== undefined &&
//       device.location.longitude !== undefined,
//   );

//   if (validDevices.length === 0) return [];

//   const storedDeviceStatus: string | null = await getTokenSecure(DEVICE_STATUS_KEY);
//   const parsedDeviceStatus: DeviceStatus[] = storedDeviceStatus
//     ? JSON.parse(storedDeviceStatus)
//     : [];

//   const insideDevices = validDevices.filter((device) => {
//     const distance = getDistancem(
//       location.coords.latitude,
//       location.coords.longitude,
//       device.location!.latitude,
//       device.location!.longitude,
//     );
//     return distance < (device.location?.range_meter ?? 0);
//   });
//   const insideDevicesUuid = new Set(insideDevices.map((d) => d.device_uuid));

//   parsedDeviceStatus.forEach((deviceStatus) => {
//     const newIsInside = insideDevicesUuid.has(deviceStatus.device_uuid);
//     if (newIsInside !== deviceStatus.isInside) {
//       appendSystemLog({
//         event_name: deviceStatus.device_uuid,
//         log_type: "INFO",
//         message: newIsInside ? "geofence enter" : "geofence exit",
//       });
//     }
//     deviceStatus.isInside = newIsInside;
//     if (!deviceStatus.isInside) deviceStatus.bleSuccess = false;
//   });

//   await setTokenSecure(DEVICE_STATUS_KEY, JSON.stringify(parsedDeviceStatus));
// };

// export const setupBgLocation = async () => {
//   // 중복 task 방지
//   const isRunning = await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK);
//   if (!isRunning) {
//     await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
//       accuracy: Location.Accuracy.High,
//       distanceInterval: 10, // 나중에 조절
//       foregroundService: {
//         notificationTitle: "위치 추적 중",
//         notificationBody: "백그라운드에서 위치를 추적하고 있습니다.",
//         notificationColor: "#2196F3",
//       },
//     });
//   }

//   appendSystemLog({
//     event_name: "BG-Tracking",
//     log_type: "INFO",
//     message: "BG Location setup",
//   });
//   return true;
// };

// export const startBgLocationTask = async () => {
//   const isRunning = await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK);
//   if (!isRunning) {
//     await setupBgLocation();
//   }

//   // 현재 위치 바로 업데이트 시도
//   try {
//     const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
//     await setTokenSecure(CURRENT_LOCATION_KEY, JSON.stringify(location));
//   } catch (e) {
//     console.log(e);
//   }

//   appendSystemLog({
//     event_name: "BG-Tracking",
//     log_type: "INFO",
//     message: "BG Location tracking start",
//   });
// };

// 네이티브 geofence 등록 함수
// ================================================================================
const TRACKING_NOTIFICATION_ID = "geofence-tracking";

// "fast" = ScanMode.LowLatency (진입 직후), "saving" = ScanMode.Balanced (그 이후),
// "paused" = 반경 안에서 정지 중이라 자동 해제 보류(걸으면 다시 검색)
export type BleScanMode = "fast" | "saving" | "paused";
// 진입·이탈 알림 id 접두사(tasks/bg-location.ts). 기기마다 하나라 이탈이 진입을 덮어쓴다
export const GEOFENCE_EVENT_NOTIFICATION_PREFIX = "geofence-event-";

// 감시 중인 기기 수와 BLE 스캔 상태를 한 알림에 함께 표시한다.
// 백그라운드 태스크가 재시작되면 이 값들은 초기화되므로, 없을 때도 문구가 성립해야 한다.
let watchedDeviceCount: number | null = null;
const bleScanning = new Map<string, BleScanMode>();

// 트래킹 중임을 알리는 고정 알림 (같은 id로 다시 그리면 갱신된다)
// asForegroundService: 이 알림으로 포그라운드 서비스를 시작한다(startTrackingService에서만).
const renderTrackingNotification = async (asForegroundService = false) => {
  const channelId = await notifee.createChannel({
    id: "tracking",
    name: "위치 트래킹",
    importance: AndroidImportance.LOW,
  });
  const modes = [...bleScanning.values()];
  const scanning = modes.filter((m) => m !== "paused").length;
  const paused = modes.length - scanning;
  const isFast = modes.includes("fast");
  await notifee.displayNotification({
    id: TRACKING_NOTIFICATION_ID,
    title: scanning > 0 ? "기기 검색 중" : paused > 0 ? "자동 해제 대기 중" : "위치 트래킹 중",
    body:
      scanning > 0
        ? `근처 기기 ${scanning}개를 ${isFast ? "빠른 검색" : "절전 검색"} 모드로 찾고 있습니다` +
          (paused > 0 ? ` · ${paused}개는 정지 대기` : "")
        : paused > 0
          ? `반경 안에서 멈춰 있어 기기 ${paused}개의 자동 해제를 쉬는 중입니다. 걸으면 바로 검색합니다`
          : watchedDeviceCount === null
          ? "등록된 기기의 주변 진입을 감시하고 있습니다"
          : `등록된 기기 ${watchedDeviceCount}개의 주변 진입을 감시하고 있습니다`,
    // 그룹을 따로 지정해야 Android 자동 묶음에 안 들어간다. 묶음에 ongoing 알림이 끼면
    // 묶음 요약까지 ongoing이 돼서 같이 묶인 일반 알림이 "모두 지우기"로 안 지워진다.
    android: {
      channelId, groupId: "tracking", ongoing: true, onlyAlertOnce: true, pressAction: { id: "default" },
      ...(asForegroundService && {
        asForegroundService: true,
        foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_LOCATION],
      }),
    },
  });
};

// 지오펜스 판정 가속: Play 서비스는 다른 위치 요청이 없으면 우리 지오펜스를 5분 주기로만 판정한다
// (실측: 960m 밖으로 옮겨도 3분 넘게 이탈 미전달). 지오펜스가 있는 동안 저전력(Wi-Fi·기지국) 위치를 30초마다
// 요청해 그 위치로 바로 판정하게 한다. watchPositionAsync는 앱이 백그라운드로 가면 expo가 멈추므로(onHostPause)
// 백그라운드용인 위치 업데이트 태스크(expo 자체 포그라운드 서비스)를 쓴다. 받은 위치는 쓰지 않는다(tasks/bg-location.ts).
// ponytail: 30초 Balanced 상시 요청이라 배터리를 더 쓴다. 줄이려면 LOCATION_POLL_MS를 늘린다.
const LOCATION_POLL_MS = 30 * 1000;
// expo는 받은 위치마다 JobScheduler 작업을 하나씩 만들고, 지오펜스 이벤트도 같은 앱 할당량의 작업으로 전달한다.
// Android 16은 포그라운드 서비스와 같이 도는 작업에도 할당량을 적용한다(실측 S24 Ultra: 배터리 최적화 예외 앱도
// 40분에 75개). 위치 작업이 이를 다 쓰면 지오펜스 작업이 WITHIN_QUOTA 미충족으로 밀려 앱을 열 때까지 전달되지 않았다.
// 값은 어차피 안 쓰므로 10분에 한 번만 묶어 넘기게 한다(위치 요청 주기는 그대로 30초).
const LOCATION_REPORT_MS = 10 * 60 * 1000;
let pollingEnsured = false; // 이 프로세스에서 포그라운드 서비스까지 올렸는지

const startLocationPolling = async () => {
  try {
    // 프로세스가 다시 뜨면 expo는 위치 등록만 복원하고 포그라운드 서비스는 올리지 않는다(실측: 서비스 없이 캐시 상태로
    // 내려감). 서비스는 앱이 화면에 있을 때만 시작할 수 있으므로, 화면에 있으면 이미 등록돼 있어도 프로세스당 한 번
    // 다시 등록해 올린다. 백그라운드에서는 등록이 없을 때만 건다.
    const foreground = AppState.currentState === "active";
    if (pollingEnsured || (!foreground && (await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK)))) return;
    await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: LOCATION_POLL_MS,
      distanceInterval: 0,
      deferredUpdatesInterval: LOCATION_REPORT_MS,
      foregroundService: {
        notificationTitle: "자동 인증 대기 중",
        notificationBody: "등록된 기기 주변 진입을 빠르게 감지하기 위해 위치를 확인하고 있습니다",
        killServiceOnDestroy: false,
      },
    });
    pollingEnsured = foreground;
    authLog("SERVICE", `위치 ${LOCATION_POLL_MS / 1000}초 간격 요청 시작 (지오펜스 판정 가속)`);
  } catch (e) {
    authLog("ERROR", `위치 요청 시작 실패(지오펜스 판정이 느려질 수 있음): ${e}`);
  }
};

// BLE 트래킹 루프가 도는 동안 트래킹 알림을 포그라운드 서비스로 올린다.
// Android 9+는 서비스 없는 백그라운드 앱에 센서(걸음) 이벤트를 주지 않는다.
// Android 12+ 백그라운드 시작 제한의 예외는 지오펜스 이벤트 직후뿐이라 서비스는 루프 시작 때 한 번만 올리고,
// 이후 문구 갱신은 같은 id의 일반 표시로 한다.
// 서비스는 프로세스만 살려 둘 뿐 CPU를 깨워 두지 않는다. 화면이 꺼지면 CPU가 잠들어 타이머가 그대로 멈추므로
// (실측: 60초 스캔 타임아웃이 33분 뒤 발화) 서비스가 떠 있는 동안 partial wakelock도 함께 잡는다.
// 만료는 해제 누락 대비 안전장치. 루프 상한(60분)보다 조금 길게 둔다.
// ponytail: 이탈 직후 재진입으로 루프가 60분 넘게 이어지면 그 뒤는 wakelock 없이 돈다(기존 동작과 같음)
const WAKE_LOCK_TIMEOUT_MS = 65 * 60 * 1000;
let serviceActive = false;
let releaseService: (() => void) | null = null;
notifee.registerForegroundService(
  () =>
    new Promise<void>((resolve) => {
      // 진단: "시작" 줄은 JS가 요청한 기록일 뿐이다. 이 줄이 있어야 OS가 서비스를 실제로 띄운 것
      authLog("SERVICE", `포그라운드 서비스 실제 기동 확인${serviceActive ? "" : " → 이미 종료 요청됨, 바로 내림"}`);
      if (!serviceActive) return resolve(); // 러너가 뜨기 전에 이미 멈췄으면 태스크를 바로 끝낸다
      releaseService = resolve;
    }),
);

export const startTrackingService = async () => {
  if (serviceActive) return;
  serviceActive = true;
  try {
    await renderTrackingNotification(true);
    const { wakeLock } = await getDevSettings();
    if (wakeLock) acquireWakeLock(WAKE_LOCK_TIMEOUT_MS);
    authLog("SERVICE", wakeLock ? "포그라운드 서비스 + wakelock 시작 (화면 꺼짐에도 타이머 유지)" : "포그라운드 서비스 시작 (wakelock 꺼짐: 디버그 설정)");
  } catch (e) {
    serviceActive = false;
    throw e;
  }
};

// 서비스를 내리면 알림도 사라지므로 호출한 쪽에서 다시 그린다(setBleScanning).
export const stopTrackingService = async () => {
  if (!serviceActive) return;
  serviceActive = false;
  releaseWakeLock();
  releaseService?.();
  releaseService = null;
  await notifee.stopForegroundService();
  // notifee는 서비스를 비동기로 내리며 마지막에 같은 id의 알림을 지운다(stopForeground(true)).
  // 바로 다시 그리면 그 뒤에 지워져 트래킹 알림이 사라지므로, 내려갈 시간을 두고 호출한 쪽이 다시 그린다.
  // ponytail: 고정 대기 1초. 기기가 느려 그래도 지워지면 서비스 알림 id를 트래킹 알림과 분리한다
  await bgSleep(1000);
  authLog("SERVICE", "포그라운드 서비스 + wakelock 종료");
};

const showTrackingNotification = async (count: number) => {
  watchedDeviceCount = count;
  await renderTrackingNotification();
  await startLocationPolling();
};

// BLE 스캔 상태를 알림에 반영. 스캔 모드가 바뀌는 순간에만 호출되므로 갱신 비용은 무시할 수준이다.
// mode가 null이면 해당 기기의 스캔 종료.
export const setBleScanning = async (uuid: string, mode: BleScanMode | null) => {
  if (mode) bleScanning.set(uuid, mode);
  else bleScanning.delete(uuid);
  await renderTrackingNotification();
};

// Android 14+는 ongoing 알림도 사용자가 밀어서 지울 수 있다. 고정할 알림이 지워지면 바로 다시 띄운다.
// 트래킹 알림은 지오펜스가 등록돼 있을 때만, 진입·이탈 알림은 디버그 설정이 켜져 있을 때만 되살린다.
export const repinNotification = async (notification: Notification) => {
  if (notification.id === TRACKING_NOTIFICATION_ID) {
    if (await TaskManager.isTaskRegisteredAsync(BG_GEOFENCE_TASK)) await renderTrackingNotification();
  } else if (notification.id?.startsWith(GEOFENCE_EVENT_NOTIFICATION_PREFIX)) {
    if ((await getDevSettings()).geofenceNotify) await notifee.displayNotification(notification);
  }
};

// 고정이라 사용자가 지울 수 없으므로 로그아웃·설정 끄기 때 직접 내린다
export const cancelGeofenceEventNotifications = async () => {
  const shown = await notifee.getDisplayedNotifications();
  await Promise.all(
    shown
      .filter((n) => n.id?.startsWith(GEOFENCE_EVENT_NOTIFICATION_PREFIX))
      .map((n) => notifee.cancelNotification(n.id!)),
  );
};

export const cancelTrackingNotification = async () => {
  bleScanning.clear();
  watchedDeviceCount = null;
  pollingEnsured = false;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK)) await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
  } catch {
    // 등록돼 있지 않으면 무시
  }
  await notifee.cancelNotification(TRACKING_NOTIFICATION_ID);
};

let lastGeoFenceSignature = ""; // 직전 등록 내용과 같으면 재등록 스킵 (stop/start 반복으로 인한 감시 공백 방지)

export const updateGeoFence = async () => {
  const devices: IoTDevice[] = await loadDevices();
  // 좌표있는 디바이스만 필터링. 게스트는 수동 인증 전용이라 감시하지 않는다(지도/상세 화면에서 연다).
  // 게스트 기기만 있으면 geofence 태스크 자체가 등록되지 않는다.
  const validDevices = devices.filter(
    (device) =>
      device.location &&
      typeof device.location.latitude === "number" &&
      typeof device.location.longitude === "number" &&
      device.role !== "guest",
  );
  const radius = (await getDevSettings()).geofenceRadiusM; // 기본 GEOFENCE_RADIUS_M, 디버그 설정에서 조절
  const geoFences = validDevices.map((device) => ({
    identifier: device.device_uuid,
    radius,
    latitude: device.location!.latitude,
    longitude: device.location!.longitude,
    notifyOnEntry: true,
    notifyOnExit: true,
  }));

  const signature = JSON.stringify(geoFences);
  if (signature === lastGeoFenceSignature) {
    // 등록은 그대로여도 알림이 지워졌거나 위치 요청이 멈췄을 수 있다. 앱 실행·홈 갱신·푸시 때 다시 맞춘다
    if (geoFences.length > 0) await showTrackingNotification(geoFences.length);
    return;
  }

  const isGeofenceRunning = await TaskManager.isTaskRegisteredAsync(BG_GEOFENCE_TASK);
  if (isGeofenceRunning) {
    await Location.stopGeofencingAsync(BG_GEOFENCE_TASK);
  }

  if (geoFences.length > 0) {
    await Location.startGeofencingAsync(BG_GEOFENCE_TASK, geoFences);
    await showTrackingNotification(geoFences.length);
    appendSystemLog({
      event_name: "BG-Tracking",
      log_type: "INFO",
      message: `updated geofences: ${geoFences.length}`,
    });
    authLog("GEOFENCE", `등록 ${geoFences.length}개 (반경 ${radius}m): ${geoFences.map((g) => short(g.identifier)).join(", ")}`);
  } else {
    await cancelTrackingNotification();
    authLog("GEOFENCE", "등록 해제: 자동 인증 대상 기기 없음(좌표 없음·게스트만)");
  }
  lastGeoFenceSignature = signature;
};

// OS가 지오펜스를 지웠을 때(위치 끄기/켜기 → GEOFENCE_NOT_AVAILABLE 등) 같은 목록이어도 다시 등록한다.
// 시그니처 캐시가 같으면 updateGeoFence가 건너뛰어 프로세스가 재시작될 때까지 감시가 멈춘다.
export const reregisterGeoFence = async () => {
  lastGeoFenceSignature = "";
  await updateGeoFence();
};

// 로그아웃 시 백그라운드 추적을 전부 내린다.
// 시그니처 캐시도 비워야 같은 기기 목록으로 다시 로그인했을 때 updateGeoFence()가 재등록을 건너뛰지 않는다.
export const stopBackgroundTracking = async () => {
  lastGeoFenceSignature = "";
  try {
    if (await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
    }
    if (await TaskManager.isTaskRegisteredAsync(BG_GEOFENCE_TASK)) {
      await Location.stopGeofencingAsync(BG_GEOFENCE_TASK);
    }
  } catch {
    // 실제로 실행 중이 아니면 무시
  }
  await cancelTrackingNotification();
  await cancelGeofenceEventNotifications();
};
