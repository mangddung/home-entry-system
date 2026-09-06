import { userTokenExchange } from "@/lib/ble";
import { loadDevices } from "@/lib/api/devices";
import {
  BG_GEOFENCE_TASK,
  DEVICE_STATUS_KEY,
} from "@/lib/constants";
import { appendSystemLog } from "@/lib/system-log";
import { getTokenSecure, setTokenSecure } from "@/lib/token-storage";
import { DeviceStatus, IoTDevice } from "@/lib/types";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

const BLE_TIMEOUT_MS = 5 * 60 * 1000; // 5분 타임아웃
const BLE_RETRY_INTERVAL_MS = 5000;

const bleInProgress = new Set<string>();
const bleTimers = new Map<string, ReturnType<typeof setTimeout>>();
const bleAbort = new Set<string>();

// 기존 GPS 폴링(distanceInterval 10m + haversine 거리계산) 기반 트리거 (native geofence로 대체, 주석 처리)
// ================================================================================
// const bleInProgress = new Set<string>();
//
// TaskManager.defineTask(BG_LOCATION_TASK, async ({ data, error }) => {
//   if (error) {
//     appendLog({ event_name: "GPS", log_type: "ERROR", message: `bg task error: ${error.message}` });
//     return;
//   }
//   if (!data) return;
//
//   const { locations } = data as { locations: LocationObject[] }; // location이 배열 형태로 반환됨
//   for (const location of locations) {
//     try {
//       // geoFence 이벤트 업데이트
//       await updateDeviceStatus(location);
//       // 현재 위치 저장
//       await setTokenSecure(CURRENT_LOCATION_KEY, JSON.stringify(location));
//
//       // device status 로드
//       const storedDeviceStatus: string | null = await getTokenSecure(DEVICE_STATUS_KEY);
//       const parsedDeviceStatus: DeviceStatus[] = storedDeviceStatus
//         ? JSON.parse(storedDeviceStatus)
//         : [];
//       const enteredDevices = parsedDeviceStatus.filter(
//         (s) => s.isInside == true && s.bleSuccess == false && !bleInProgress.has(s.device_uuid),
//       );
//       const enteredDevicesUuid = new Set(enteredDevices.map((d) => d.device_uuid));
//       if (enteredDevices.length === 0) continue;
//
//       // devices 로드
//       const devices: IoTDevice[] = await loadDevices();
//
//       const bleTargetDevices = devices.filter((d) => {
//         if (!enteredDevicesUuid.has(d.device_uuid)) return false;
//         if (!d.auth_token) {
//           appendSystemLog({
//             event_name: d.device_uuid,
//             log_type: "INFO",
//             message: "ble tracking skipped: auth_token is null",
//           });
//           return false;
//         }
//         return true;
//       });
//
//       // BLE 트래킹 시작
//       for (const device of bleTargetDevices) {
//         bleInProgress.add(device.device_uuid);
//         void (async () => {
//           appendSystemLog({
//             event_name: device.device_uuid,
//             log_type: "INFO",
//             message: `ble tracking try`,
//           });
//           try {
//             await userTokenExchange(device);
//           } catch {
//             await new Promise((resolve) => setTimeout(resolve, 10000));
//           } finally {
//             bleInProgress.delete(device.device_uuid);
//           }
//         })();
//       }
//       appendLog({
//         event_name: "GPS",
//         log_type: "INFO",
//         message: `latitude: ${location.coords.latitude}, longtiude: ${location.coords.longitude}, speed: ${location.coords.speed}`,
//       });
//     } catch (e) {
//       appendLog({ event_name: "GPS", log_type: "ERROR", message: `onLocation error: ${e}` });
//     }
//   }
// });

// 네이티브 geofence 기반 BLE 트리거
// ================================================================================
const stopBleTracking = (uuid: string) => {
  bleAbort.add(uuid);
  const timer = bleTimers.get(uuid);
  if (timer) clearTimeout(timer);
  bleTimers.delete(uuid);
};

const startBleTracking = async (device: IoTDevice) => {
  const uuid = device.device_uuid;
  if (bleInProgress.has(uuid)) return;
  bleInProgress.add(uuid);
  bleAbort.delete(uuid);
  bleTimers.set(uuid, setTimeout(() => stopBleTracking(uuid), BLE_TIMEOUT_MS));

  appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking start (geofence enter)" });

  try {
    while (!bleAbort.has(uuid)) {
      try {
        await userTokenExchange(device);
      } catch {
        // 무시하고 재시도
      }

      const storedDeviceStatus: string | null = await getTokenSecure(DEVICE_STATUS_KEY);
      const parsedDeviceStatus: DeviceStatus[] = storedDeviceStatus
        ? JSON.parse(storedDeviceStatus)
        : [];
      const status = parsedDeviceStatus.find((s) => s.device_uuid === uuid);
      if (status?.bleSuccess) {
        appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking success, door opened" });
        break;
      }
      if (bleAbort.has(uuid)) break;
      await new Promise((resolve) => setTimeout(resolve, BLE_RETRY_INTERVAL_MS));
    }
    if (bleAbort.has(uuid)) {
      appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking stopped (timeout or exit)" });
    }
  } finally {
    stopBleTracking(uuid);
    bleInProgress.delete(uuid);
  }
};

TaskManager.defineTask(BG_GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    appendSystemLog({
      event_name: "Geofence",
      log_type: "ERROR",
      message: `geofence error: ${error.message}`,
    });
    return;
  }
  if (!data) return;

  const { eventType, region } = data as {
    eventType: Location.LocationGeofencingEventType;
    region: Location.LocationRegion;
  };
  const uuid = region.identifier ?? "";
  if (!uuid) return;

  const storedDeviceStatus: string | null = await getTokenSecure(DEVICE_STATUS_KEY);
  const parsedDeviceStatus: DeviceStatus[] = storedDeviceStatus
    ? JSON.parse(storedDeviceStatus)
    : [];
  const status = parsedDeviceStatus.find((s) => s.device_uuid === uuid);

  if (eventType === Location.LocationGeofencingEventType.Enter) {
    appendSystemLog({ event_name: uuid, log_type: "INFO", message: "geofence enter" });
    if (status) status.isInside = true;
    await setTokenSecure(DEVICE_STATUS_KEY, JSON.stringify(parsedDeviceStatus));

    if (status?.bleSuccess) return; // 이미 열려 있으면 스킵

    const devices = await loadDevices();
    const device = devices.find((d) => d.device_uuid === uuid);
    if (!device) return;
    if (!device.auth_token) {
      appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking skipped: auth_token is null" });
      return;
    }
    void startBleTracking(device);
  } else if (eventType === Location.LocationGeofencingEventType.Exit) {
    appendSystemLog({ event_name: uuid, log_type: "INFO", message: "geofence exit" });
    if (status) {
      status.isInside = false;
      status.bleSuccess = false;
    }
    await setTokenSecure(DEVICE_STATUS_KEY, JSON.stringify(parsedDeviceStatus));
    stopBleTracking(uuid);
  }
});
