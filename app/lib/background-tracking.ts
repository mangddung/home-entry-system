// 등록된 기기 위치마다 고정 반경(GEOFENCE_RADIUS_M) geofence를 걸고,
// 진입 이벤트가 오면 BLE 스캔으로 실제 근접 판정을 넘긴다.

import notifee, { AndroidImportance } from "@notifee/react-native";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { loadDevices } from "./api/devices";
import {
  BG_GEOFENCE_TASK,
  BG_LOCATION_TASK,
  GEOFENCE_RADIUS_M,
} from "./constants";
import { isTokenAlive } from "./schedule";
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

// "fast" = ScanMode.LowLatency (진입 직후), "saving" = ScanMode.Balanced (그 이후)
export type BleScanMode = "fast" | "saving";

// 감시 중인 기기 수와 BLE 스캔 상태를 한 알림에 함께 표시한다.
// 백그라운드 태스크가 재시작되면 이 값들은 초기화되므로, 없을 때도 문구가 성립해야 한다.
let watchedDeviceCount: number | null = null;
const bleScanning = new Map<string, BleScanMode>();

// 트래킹 중임을 알리는 고정 알림 (같은 id로 다시 그리면 갱신된다)
const renderTrackingNotification = async () => {
  const channelId = await notifee.createChannel({
    id: "tracking",
    name: "위치 트래킹",
    importance: AndroidImportance.LOW,
  });
  const scanning = bleScanning.size;
  const isFast = [...bleScanning.values()].includes("fast");
  await notifee.displayNotification({
    id: TRACKING_NOTIFICATION_ID,
    title: scanning > 0 ? "기기 검색 중" : "위치 트래킹 중",
    body:
      scanning > 0
        ? `근처 기기 ${scanning}개를 ${isFast ? "빠른 검색" : "절전 검색"} 모드로 찾고 있습니다`
        : watchedDeviceCount === null
          ? "등록된 기기의 주변 진입을 감시하고 있습니다"
          : `등록된 기기 ${watchedDeviceCount}개의 주변 진입을 감시하고 있습니다`,
    android: { channelId, ongoing: true, onlyAlertOnce: true, pressAction: { id: "default" } },
  });
};

const showTrackingNotification = async (count: number) => {
  watchedDeviceCount = count;
  await renderTrackingNotification();
};

// BLE 스캔 상태를 알림에 반영. 스캔 모드가 바뀌는 순간에만 호출되므로 갱신 비용은 무시할 수준이다.
// mode가 null이면 해당 기기의 스캔 종료.
export const setBleScanning = async (uuid: string, mode: BleScanMode | null) => {
  if (mode) bleScanning.set(uuid, mode);
  else bleScanning.delete(uuid);
  await renderTrackingNotification();
};

export const cancelTrackingNotification = async () => {
  bleScanning.clear();
  watchedDeviceCount = null;
  await notifee.cancelNotification(TRACKING_NOTIFICATION_ID);
};

let lastGeoFenceSignature = ""; // 직전 등록 내용과 같으면 재등록 스킵 (stop/start 반복으로 인한 감시 공백 방지)

export const updateGeoFence = async () => {
  const devices: IoTDevice[] = await loadDevices();
  // 좌표있는 디바이스만 필터링. 게스트는 만료 전 토큰이 있을 때만 감시한다(없으면 BLE를 시도할 수 없다).
  // 스케줄 시간대는 여기서 보지 않는다: 시간대 전에 반경 안에 들어와 머물면 진입 이벤트가 다시 오지 않으므로
  // 지오펜스는 켜두고 BLE 루프가 시간대를 기다린다(tasks/bg-location.ts).
  const validDevices = devices.filter(
    (device) =>
      device.location &&
      device.location.latitude !== undefined &&
      device.location.longitude !== undefined &&
      (device.role !== "guest" || isTokenAlive(device.auth_token)),
  );
  const geoFences = validDevices.map((device) => ({
    identifier: device.device_uuid,
    radius: GEOFENCE_RADIUS_M,
    latitude: device.location!.latitude,
    longitude: device.location!.longitude,
    notifyOnEntry: true,
    notifyOnExit: true,
  }));

  const signature = JSON.stringify(geoFences);
  if (signature === lastGeoFenceSignature) return;

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
  } else {
    await cancelTrackingNotification();
  }
  lastGeoFenceSignature = signature;
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
};
