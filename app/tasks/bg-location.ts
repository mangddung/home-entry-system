import { updateDeviceStatus } from "@/lib/background-tracking";
import { userTokenExchange } from "@/lib/ble";
import { loadDevices } from "@/lib/api/devices";
import {
  BG_LOCATION_TASK,
  CURRENT_LOCATION_KEY,
  DEVICE_STATUS_KEY,
} from "@/lib/constants";
import { appendLog, appendSystemLog } from "@/lib/system-log";
import { getTokenSecure, setTokenSecure } from "@/lib/token-storage";
import { DeviceStatus, IoTDevice } from "@/lib/types";
import { LocationObject } from "expo-location";
import * as TaskManager from "expo-task-manager";

const bleInProgress = new Set<string>();

TaskManager.defineTask(BG_LOCATION_TASK, async ({ data, error }) => {
  if (error) {
    appendLog({ event_name: "GPS", log_type: "ERROR", message: `bg task error: ${error.message}` });
    return;
  }
  if (!data) return;

  const { locations } = data as { locations: LocationObject[] }; // location이 배열 형태로 반환됨
  for (const location of locations) {
    try {
      // geoFence 이벤트 업데이트
      await updateDeviceStatus(location);
      // 현재 위치 저장
      await setTokenSecure(CURRENT_LOCATION_KEY, JSON.stringify(location));

      // device status 로드
      const storedDeviceStatus: string | null = await getTokenSecure(DEVICE_STATUS_KEY);
      const parsedDeviceStatus: DeviceStatus[] = storedDeviceStatus
        ? JSON.parse(storedDeviceStatus)
        : [];
      const enteredDevices = parsedDeviceStatus.filter(
        (s) => s.isInside == true && s.bleSuccess == false && !bleInProgress.has(s.device_uuid),
      );
      const enteredDevicesUuid = new Set(enteredDevices.map((d) => d.device_uuid));
      if (enteredDevices.length === 0) continue;

      // devices 로드
      const devices: IoTDevice[] = await loadDevices();

      const bleTargetDevices = devices.filter((d) => {
        if (!enteredDevicesUuid.has(d.device_uuid)) return false;
        if (!d.auth_token) {
          appendSystemLog({
            event_name: d.device_uuid,
            log_type: "INFO",
            message: "ble tracking skipped: auth_token is null",
          });
          return false;
        }
        return true;
      });

      // BLE 트래킹 시작
      for (const device of bleTargetDevices) {
        bleInProgress.add(device.device_uuid);
        void (async () => {
          appendSystemLog({
            event_name: device.device_uuid,
            log_type: "INFO",
            message: `ble tracking try`,
          });
          try {
            await userTokenExchange(device);
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10000));
          } finally {
            bleInProgress.delete(device.device_uuid);
          }
        })();
      }
      appendLog({
        event_name: "GPS",
        log_type: "INFO",
        message: `latitude: ${location.coords.latitude}, longtiude: ${location.coords.longitude}, speed: ${location.coords.speed}`,
      });
    } catch (e) {
      appendLog({ event_name: "GPS", log_type: "ERROR", message: `onLocation error: ${e}` });
    }
  }
});

// TaskManager.defineTask(BG_GEOFENCE_TASK, async ({ data, error }) => {
//   if (error) {
//     appendSystemLog({
//       event_name: "Geofence",
//       log_type: "ERROR",
//       message: `geofence error: ${error.message}`,
//     });
//     return;
//   }
//   if (!data) return;

//   const { eventType, region } = data as {
//     eventType: Location.LocationGeofencingEventType;
//     region: Location.LocationRegion;
//   };

//   const identifier = region.identifier ?? "unknown";

//   const updatedAt = await getTokenSecure(GEOFENCE_UPDATED_AT_KEY);
//   const isRecentUpdate = updatedAt && Date.now() - Number(updatedAt) < 5000; // 5초 이내 이벤트인지 확인

//   if (eventType === Location.LocationGeofencingEventType.Enter && !isRecentUpdate) {
//     isInsideGeofence = true;
//     appendSystemLog({ event_name: identifier, log_type: "INFO", message: "geofence enter event" });

//     let retryCount = 1;
//     const storedData: string | null = await getTokenSecure(USER_DEVICES_KEY);
//     const devices: IoTDevice[] = storedData ? JSON.parse(storedData) : [];
//     const targetDevice = devices.find((device) => device.device_uuid === identifier);
//     if (targetDevice) {
//       while (retryCount < 10 && isInsideGeofence) {
//         appendSystemLog({
//           event_name: identifier,
//           log_type: "INFO",
//           message: `ble tracking retry: ${retryCount}`,
//         });
//         try {
//           await scanAndConnect(targetDevice);
//           break;
//         } catch {
//           retryCount++;
//           await new Promise((resolve) => setTimeout(resolve, 2000));
//           if (!isInsideGeofence) {
//             appendSystemLog({
//               event_name: identifier,
//               log_type: "INFO",
//               message: "geofence exit event, stop ble tracking",
//             });
//             break;
//           }
//         }
//       }
//     }
//     // exit 이벤트
//   } else if (eventType === Location.LocationGeofencingEventType.Exit && !isRecentUpdate) {
//     isInsideGeofence = false;
//     appendSystemLog({ event_name: identifier, log_type: "INFO", message: "geofence exit event" });
//   }
// });
