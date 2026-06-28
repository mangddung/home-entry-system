// 사용자 활동, GPS 거리 기반 인터벌 조절
// devices가 여러개 일때 가까운 지역 기준
// devices.range_meter 범위 안에 들어오면 ble 트래킹 시작

import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { loadDevices } from "./api/devices";
import {
  BG_LOCATION_TASK,
  CURRENT_LOCATION_KEY,
  DEVICE_STATUS_KEY,
} from "./constants";
import { appendSystemLog } from "./system-log";
import { getTokenSecure, setTokenSecure } from "./token-storage";
import { DeviceStatus, IoTDevice } from "./types";

// 유틸 함수 정의
// ================================================================================
const getDistancem = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  if (lat1 == lat2 && lon1 == lon2) return 0;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c * 1000;
};

export const updateDeviceStatus = async (location: Location) => {
  const devices: IoTDevice[] = await loadDevices();
  const validDevices = devices.filter(
    (device) =>
      device.location &&
      device.location.latitude !== undefined &&
      device.location.longitude !== undefined,
  );

  if (validDevices.length === 0) return [];

  const storedDeviceStatus: string | null = await getTokenSecure(DEVICE_STATUS_KEY);
  const parsedDeviceStatus: DeviceStatus[] = storedDeviceStatus
    ? JSON.parse(storedDeviceStatus)
    : [];

  const insideDevices = validDevices.filter((device) => {
    const distance = getDistancem(
      location.coords.latitude,
      location.coords.longitude,
      device.location!.latitude,
      device.location!.longitude,
    );
    return distance < (device.location?.range_meter ?? 0);
  });
  const insideDevicesUuid = new Set(insideDevices.map((d) => d.device_uuid));

  parsedDeviceStatus.forEach((deviceStatus) => {
    const newIsInside = insideDevicesUuid.has(deviceStatus.device_uuid);
    if (newIsInside !== deviceStatus.isInside) {
      appendSystemLog({
        event_name: deviceStatus.device_uuid,
        log_type: "INFO",
        message: newIsInside ? "geofence enter" : "geofence exit",
      });
    }
    deviceStatus.isInside = newIsInside;
    if (!deviceStatus.isInside) deviceStatus.bleSuccess = false;
  });

  await setTokenSecure(DEVICE_STATUS_KEY, JSON.stringify(parsedDeviceStatus));
};

// 위치 트래킹 호출 함수
// ================================================================================
export const setupBgLocation = async () => {
  // 중복 task 방지
  const isRunning = await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK);
  if (!isRunning) {
    await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
      accuracy: Location.Accuracy.High,
      distanceInterval: 10, // 나중에 조절
      foregroundService: {
        notificationTitle: "위치 추적 중",
        notificationBody: "백그라운드에서 위치를 추적하고 있습니다.",
        notificationColor: "#2196F3",
      },
    });
  }

  appendSystemLog({
    event_name: "BG-Tracking",
    log_type: "INFO",
    message: "BG Location setup",
  });
  return true;
};

export const startBgLocationTask = async () => {
  const isRunning = await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK);
  if (!isRunning) {
    await setupBgLocation();
  }

  // 현재 위치 바로 업데이트 시도
  try {
    const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    await setTokenSecure(CURRENT_LOCATION_KEY, JSON.stringify(location));
  } catch (e) {
    console.log(e);
  }

  appendSystemLog({
    event_name: "BG-Tracking",
    log_type: "INFO",
    message: "BG Location tracking start",
  });
};

// export const updateGeoFence = async () => {
//   const isGeofenceRunning = await TaskManager.isTaskRegisteredAsync(BG_GEOFENCE_TASK);
//   if (isGeofenceRunning) {
//     await Location.stopGeofencingAsync(BG_GEOFENCE_TASK);
//   }

//   const storedData: string | null = await getTokenSecure(USER_DEVICES_KEY);
//   const devices: IoTDevice[] = storedData ? JSON.parse(storedData) : [];
//   // 좌표있는 디바이스만 필터링
//   const validDevices = devices.filter(
//     (device) =>
//       device.location &&
//       device.location.latitude !== undefined &&
//       device.location.longitude !== undefined,
//   );
//   const geoFences = validDevices.map((device) => ({
//     identifier: device.device_uuid,
//     radius: device.location!.range_meter,
//     latitude: device.location!.latitude,
//     longitude: device.location!.longitude,
//     notifyOnEntry: true,
//     notifyOnExit: true,
//   }));

//   if (geoFences.length > 0) {
//     await setTokenSecure(GEOFENCE_UPDATED_AT_KEY, Date.now().toString());
//     await Location.startGeofencingAsync(BG_GEOFENCE_TASK, geoFences);
//     appendSystemLog({
//       event_name: "BG-Tracking",
//       log_type: "INFO",
//       message: `updated geofences: ${geoFences.length}`,
//     });
//   }
// };
