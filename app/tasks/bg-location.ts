import { setBleScanning } from "@/lib/background-tracking";
import { userTokenExchange } from "@/lib/ble";
import { ScanMode } from "react-native-ble-plx";
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

// geofence 진입 직후에는 문으로 이동 중일 확률이 높아 고반응 스캔,
// 그 뒤로는 저전력 스캔으로 내려 exit까지 계속 감시한다.
// (짧은 타임아웃을 쓰면 반경 안에 상주하다 나중에 문 앞으로 갔을 때 스캔이 이미 꺼져 있다)
const BLE_BURST_MS = 2 * 60 * 1000;
const BLE_MAX_TRACKING_MS = 12 * 60 * 60 * 1000; // exit 이벤트가 유실될 때를 위한 안전 상한
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
  bleTimers.set(uuid, setTimeout(() => stopBleTracking(uuid), BLE_MAX_TRACKING_MS));

  appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking start (geofence enter)" });

  const startedAt = Date.now();
  let lastBurst: boolean | null = null;

  try {
    while (!bleAbort.has(uuid)) {
      const burst = Date.now() - startedAt < BLE_BURST_MS;
      // 스캔 모드가 바뀔 때만 알림을 갱신한다 (스캔 시작 시 1회 + burst 종료 시 1회)
      if (burst !== lastBurst) {
        lastBurst = burst;
        void setBleScanning(uuid, burst ? "fast" : "saving");
      }
      try {
        await userTokenExchange(
          device,
          burst
            ? { scanMode: ScanMode.LowLatency, timeoutMs: 30000 }
            // 배터리를 더 줄여야 하면 ScanMode.LowPower로 내린다.
            // Balanced는 duty 25%(1024ms/4096ms), LowPower는 10%(512ms/5120ms)로 최악 발견 지연은 4초 -> 5초 차이뿐이다.
            // 펌웨어 광고 주기가 30~60ms라 LowPower 스캔 창에도 충분히 걸리지만,
            // 일부 제조사가 LowPower를 더 공격적으로 스로틀하므로 실기기 확인 후 내릴 것.
            : { scanMode: ScanMode.Balanced, timeoutMs: 60000 },
        );
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
    void setBleScanning(uuid, null);
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
