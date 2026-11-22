import { checkBluetoothPermission } from "@/hooks/request-ble-permit";
import { reregisterGeoFence, setBleScanning, startTrackingService, stopTrackingService } from "@/lib/background-tracking";
import { authLog, short } from "@/lib/auth-log";
import { scanDevice, userTokenExchange } from "@/lib/ble";
import { getThresholdFor, recordTrigger } from "@/lib/proximity";
import { ScanMode } from "react-native-ble-plx";
import { loadDevices, updateDeviceStatus } from "@/lib/api/devices";
import {
  BG_GEOFENCE_TASK,
  DEVICE_STATUS_KEY,
} from "@/lib/constants";
import { isTokenAlive } from "@/lib/schedule";
import { appendSystemLog } from "@/lib/system-log";
import { getTokenSecure } from "@/lib/token-storage";
import { DeviceStatus, IoTDevice } from "@/lib/types";
import {
  bgSleep,
  clearBgTimeout,
  getLastStepAt,
  setBgTimeout,
  startStepWatch,
  stopStepWatch,
} from "@/modules/activity-transition";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

// geofence 진입 직후에는 문으로 이동 중일 확률이 높아 고반응 스캔,
// 그 뒤로는 저전력 스캔으로 내려 exit까지 계속 감시한다.
// (짧은 타임아웃을 쓰면 반경 안에 상주하다 나중에 문 앞으로 갔을 때 스캔이 이미 꺼져 있다)
const BLE_BURST_MS = 2 * 60 * 1000;
// exit 이벤트가 유실될 때를 위한 안전 상한. 반경 안에 이보다 오래 머물면 자동 BLE가 멈추고
// 진입 이벤트가 다시 오지 않으므로 수동 인증으로 연다.
// TODO: 추후 사용자 설정으로 변경 가능하게 추가할 예정
const BLE_MAX_TRACKING_MS = 60 * 60 * 1000;
const BLE_RETRY_INTERVAL_MS = 5000;
// 절전 스캔 중 기기가 보이면 이 시간 동안 빠른 스캔으로 RSSI 상승을 추적한다
const BLE_PROMOTE_MS = 45 * 1000;
// N3 릴레이 완화: 반경 안에서 이 시간 넘게 걷지 않았으면(정지) 자동 해제에 응답하지 않는다.
// 카페·사무실처럼 오래 앉아 있는 동안의 중계를 막고, 엘리베이터 대기·탑승 정도는 통과시킨다.
// 기준은 걸음 센서의 마지막 걸음 시각이라 차량으로 진입하면 내려서 걷기 시작할 때까지 막힌다.
const STILL_DENY_MS = 5 * 60 * 1000;

const bleInProgress = new Set<string>();
const bleTimers = new Map<string, number>();
const bleAbort = new Set<string>();
const bleStopReason = new Map<string, string>(); // 자동 인증 로그용 중단 사유

const secs = (ms: number) => `${Math.round(ms / 1000)}초`;

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
const stopBleTracking = (uuid: string, reason: string) => {
  if (!bleStopReason.has(uuid)) bleStopReason.set(uuid, reason);
  bleAbort.add(uuid);
  const timer = bleTimers.get(uuid);
  if (timer) clearBgTimeout(timer);
  bleTimers.delete(uuid);
};

const startBleTracking = async (initialDevice: IoTDevice, enteredAt: number) => {
  const uuid = initialDevice.device_uuid;
  const dev = short(uuid);
  let device = initialDevice;
  if (bleInProgress.has(uuid)) {
    if (!bleAbort.has(uuid)) {
      authLog("BLE", `${dev} 이미 추적 중 → 이번 진입은 무시`);
      return; // 이미 추적 중
    }
    // exit 직후 재진입: 이전 루프가 abort를 아직 확인하기 전이다. 그냥 돌아가면 그 루프가 곧 끝나
    // 이번 진입이 사라지므로(Enter는 다시 오지 않는다) abort를 풀고 그 루프를 이어 쓴다.
    // 루프의 while 확인부터 finally의 bleInProgress.delete까지는 await가 없어 여기서 풀면 루프가 반드시 계속 돈다.
    bleAbort.delete(uuid);
    bleStopReason.delete(uuid);
    bleTimers.set(uuid, setBgTimeout(() => stopBleTracking(uuid, `${BLE_MAX_TRACKING_MS / 60000}분 상한`), BLE_MAX_TRACKING_MS));
    appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking resumed (re-enter before stop)" });
    authLog("BLE", `${dev} 이탈 직후 재진입 → 기존 추적 루프 이어서 사용`);
    return;
  }
  bleInProgress.add(uuid);
  bleAbort.delete(uuid);
  bleStopReason.delete(uuid);
  bleTimers.set(uuid, setBgTimeout(() => stopBleTracking(uuid, `${BLE_MAX_TRACKING_MS / 60000}분 상한`), BLE_MAX_TRACKING_MS));

  appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking start (geofence enter)" });
  // 루프가 도는 동안 포그라운드 서비스와 wakelock을 유지한다(background-tracking.ts 참고).
  // 지오펜스 이벤트 직후라 백그라운드 시작 제한의 예외에 걸린다. 실패해도 루프는 기존처럼 돈다.
  try {
    await startTrackingService();
  } catch (e) {
    appendSystemLog({ event_name: uuid, log_type: "ERROR", message: `foreground service start failed: ${e}` });
    authLog("ERROR", `${dev} 포그라운드 서비스 시작 실패(백그라운드에서 타이머가 멈출 수 있음): ${e}`);
  }
  // 정지 판정용 걸음 센서. 루프가 도는 동안 켜 둔다(겹친 루프가 있으면 이미 켜져 있다)
  await startStepWatch().catch((e) => authLog("ERROR", `${dev} 걸음 센서 시작 실패: ${e}`));

  const startedAt = Date.now();
  let lastBurst: boolean | null = null;
  let stillDenied: boolean | null = null; // null = 아직 판정 전(첫 회차에 판정 결과를 남긴다)
  let attempts = 0;
  let lastThreshold: number | null | undefined;
  let triggerRssi: number | null = null;
  const trace = (message: string) => authLog("BLE", `${dev} ${message}`);
  authLog("BLE", `${dev} 추적 시작 (${device.device_nickname}, 진입 후 ${Date.now() - enteredAt}ms, 빠른 스캔 ${secs(BLE_BURST_MS)} → 절전)`);

  try {
    while (!bleAbort.has(uuid)) {
      // 대기·재시도 중에 토큰이 삭제·재발급될 수 있어 캐시에서 최신 값을 다시 읽는다
      // (푸시로 갱신된 캐시를 반영. 지오펜스 해제는 exit 이벤트를 주지 않는다)
      const latest = (await loadDevices()).find((d) => d.device_uuid === uuid);
      if (!latest || !isTokenAlive(latest.auth_token)) {
        appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking stopped: token gone" });
        bleStopReason.set(uuid, latest ? "출입 토큰 만료·삭제" : "기기 목록에서 사라짐");
        break;
      }
      device = latest;

      // 백그라운드에서는 권한을 물을 수 없다(Activity 없음). 없으면 60분 동안 헛돌지 말고 멈춘다.
      if (!(await checkBluetoothPermission())) {
        bleStopReason.set(uuid, "근처 기기/위치 권한 없음 (앱을 열어 허용 필요)");
        break;
      }

      // 오래 걷지 않았으면 스캔·토큰 교환을 건너뛰고, 다시 걸으면 다음 회차에 바로 재개한다.
      // 걸음 센서를 못 읽으면(null) 기존 동작대로 진행한다.
      const lastStepAt = getLastStepAt();
      const idleMs = lastStepAt == null ? null : Date.now() - lastStepAt;
      const denied = idleMs != null && idleMs >= STILL_DENY_MS;
      if (denied !== stillDenied) {
        const first = stillDenied === null;
        stillDenied = denied;
        if (!first || denied) {
          appendSystemLog({
            event_name: uuid,
            log_type: "INFO",
            message: denied ? `ble paused: still over ${STILL_DENY_MS / 60000}min` : "ble resumed: moving",
          });
        }
        authLog(
          "ACTIVITY",
          denied
            ? `${dev} 자동 해제 보류: 마지막 걸음 ${secs(idleMs!)} 전 (기준 ${STILL_DENY_MS / 60000}분)`
            : idleMs == null
              ? `${dev} 걸음 센서 응답 없음 → 정지 판정 없이 진행`
              : `${dev} 자동 해제 ${first ? "허용" : "재개"}: 마지막 걸음 ${secs(idleMs)} 전`,
        );
        // 쉬는 동안 알림이 "검색 중"으로 남지 않게 내리고, 재개 시 다시 그린다
        if (denied) void setBleScanning(uuid, null);
        lastBurst = null;
      }
      if (denied) {
        await bgSleep(BLE_RETRY_INTERVAL_MS);
        continue;
      }

      const burst = Date.now() - startedAt < BLE_BURST_MS;
      // 스캔 모드가 바뀔 때만 알림을 갱신한다 (스캔 시작 시 1회 + burst 종료 시 1회)
      if (burst !== lastBurst) {
        lastBurst = burst;
        void setBleScanning(uuid, burst ? "fast" : "saving");
      }
      // 근접 문턱(내 보정 > 기기 임계값). 없으면 기존처럼 첫 발견 즉시 연결.
      const threshold = await getThresholdFor(device);
      if (threshold !== lastThreshold) {
        lastThreshold = threshold;
        trace(threshold == null ? "근접 문턱 없음 → 발견 즉시 연결" : `근접 문턱 ${threshold}dBm (내 보정 > 기기 기준)`);
      }
      const gate =
        threshold == null
          ? undefined
          : {
              threshold,
              onTrigger: (rssi: number) => {
                triggerRssi = rssi;
                void recordTrigger(uuid, rssi, threshold);
              },
            };
      // 배터리를 더 줄여야 하면 ScanMode.LowPower로 내린다.
      // Balanced는 duty 25%(1024ms/4096ms), LowPower는 10%(512ms/5120ms)로 최악 발견 지연은 4초 -> 5초 차이뿐이다.
      // 펌웨어 광고 주기가 30~60ms라 LowPower 스캔 창에도 충분히 걸리지만,
      // 일부 제조사가 LowPower를 더 공격적으로 스로틀하므로 실기기 확인 후 내릴 것.
      const saving = { scanMode: ScanMode.Balanced, timeoutMs: 60000, trace };
      attempts++;
      triggerRssi = null;
      const attemptAt = Date.now();
      let sent = false;
      try {
        if (burst) {
          sent = await userTokenExchange(device, { scanMode: ScanMode.LowLatency, timeoutMs: 30000, gate, trace });
        } else if (!gate) {
          sent = await userTokenExchange(device, saving);
        } else {
          // 절전 스캔은 샘플이 ~4초에 한 묶음이라 RSSI 판정이 늦다 → 발견만 하고,
          // 잡히면 빠른 스캔으로 재승격해 다가오는 RSSI를 추적한다(못 넘으면 다음 회차에 다시 절전).
          const seen = await scanDevice(device, undefined, saving);
          if (seen.length > 0 && !bleAbort.has(uuid)) {
            appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble promote to fast (device seen)" });
            trace(`절전 스캔에서 발견(RSSI ${seen[0].rssi ?? "?"}dBm) → 빠른 스캔으로 ${secs(BLE_PROMOTE_MS)} 승격`);
            void setBleScanning(uuid, "fast");
            lastBurst = null; // 다음 회차에 절전 표시로 되돌린다
            sent = await userTokenExchange(device, { scanMode: ScanMode.LowLatency, timeoutMs: BLE_PROMOTE_MS, gate, trace });
          }
        }
      } catch (e) {
        // 무시하고 재시도
        authLog("ERROR", `${dev} 시도 #${attempts} 예외: ${e}`);
      }

      if (sent) {
        const now = Date.now();
        authLog(
          "AUTH",
          `${dev} 응답값 전송 성공 (시도 #${attempts}) · 트리거 RSSI ${triggerRssi ?? "없음(문턱 없음)"}${threshold != null ? ` / 문턱 ${threshold}dBm` : ""}` +
            ` · 이번 시도 ${now - attemptAt}ms · 추적 시작 후 ${secs(now - startedAt)} · 지오펜스 진입 후 ${secs(now - enteredAt)}` +
            ` · 서버 결과는 PUSH 줄 확인`,
        );
      }

      const storedDeviceStatus: string | null = await getTokenSecure(DEVICE_STATUS_KEY);
      const parsedDeviceStatus: DeviceStatus[] = storedDeviceStatus
        ? JSON.parse(storedDeviceStatus)
        : [];
      const status = parsedDeviceStatus.find((s) => s.device_uuid === uuid);
      if (status?.bleSuccess) {
        appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking success, door opened" });
        bleStopReason.set(uuid, "인증 완료");
        break;
      }
      if (bleAbort.has(uuid)) break;
      await bgSleep(BLE_RETRY_INTERVAL_MS);
    }
    if (bleAbort.has(uuid)) {
      appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking stopped (timeout or exit)" });
    }
  } catch (e) {
    bleStopReason.set(uuid, `예외: ${e}`);
    authLog("ERROR", `${dev} 추적 루프 예외: ${e}`);
  } finally {
    authLog("BLE", `${dev} 추적 종료: ${bleStopReason.get(uuid) || "?"} · ${secs(Date.now() - startedAt)}, 시도 ${attempts}회`);
    stopBleTracking(uuid, "");
    bleStopReason.delete(uuid);
    bleInProgress.delete(uuid);
    // 겹친 지오펜스의 다른 루프가 남아 있으면 서비스·걸음 센서를 유지한다. 내린 뒤 알림을 다시 그린다.
    // (await 사이에 새 진입이 루프를 시작했을 수 있어 각각 다시 확인한다)
    if (bleInProgress.size === 0) await stopStepWatch().catch(() => {});
    if (bleInProgress.size === 0) await stopTrackingService().catch(() => {});
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
    // 위치를 껐다 켜는 등으로 OS가 지오펜스를 지우면(GEOFENCE_NOT_AVAILABLE) 이 오류가 온다.
    // 같은 목록이라도 다시 등록한다. 위치가 아직 꺼져 있으면 실패하고 다음 updateGeoFence(앱 실행·홈 갱신·푸시) 때 재시도된다.
    authLog("ERROR", `지오펜스 오류: ${error.message} → 재등록 시도`);
    try {
      await reregisterGeoFence();
    } catch (e) {
      authLog("ERROR", `지오펜스 재등록 실패: ${e}`);
    }
    return;
  }
  if (!data) return;

  const { eventType, region } = data as {
    eventType: Location.LocationGeofencingEventType;
    region: Location.LocationRegion;
  };
  const uuid = region.identifier ?? "";
  if (!uuid) return;
  const dev = short(uuid);

  // 겹친 지오펜스는 영역마다 태스크가 따로 동시에 돌므로 상태 저장은 updateDeviceStatus로 직렬화한다
  if (eventType === Location.LocationGeofencingEventType.Enter) {
    appendSystemLog({ event_name: uuid, log_type: "INFO", message: "geofence enter" });
    const enteredAt = Date.now();
    let opened = false;
    await updateDeviceStatus((list) => {
      let status = list.find((s) => s.device_uuid === uuid);
      // 항목이 없으면(fetchDevices 전·로그인 직후 등) 만든다. 없으면 성공 기록이 안 남아 루프가 문을 반복해서 연다.
      if (!status) {
        status = { device_uuid: uuid, isInside: false, bleSuccess: false };
        list.push(status);
      }
      status.isInside = true;
      status.enteredAt = enteredAt;
      opened = status.bleSuccess;
      return list;
    });

    if (opened) {
      authLog("GEOFENCE", `${dev} 진입 → 건너뜀: 이번 체류 중 이미 인증함(이탈 시 초기화)`);
      return; // 이미 열려 있으면 스킵
    }

    const devices = await loadDevices();
    const device = devices.find((d) => d.device_uuid === uuid);
    // 게스트는 수동 인증 전용. 역할 변경 직후 재등록 전 남은 geofence 이벤트를 막는다.
    if (!device || device.role === "guest") {
      authLog("GEOFENCE", `${dev} 진입 → 건너뜀: ${device ? "게스트(수동 인증 전용)" : "기기 목록에 없음"}`);
      return;
    }
    if (!isTokenAlive(device.auth_token)) {
      appendSystemLog({ event_name: uuid, log_type: "INFO", message: "ble tracking skipped: no valid auth_token" });
      authLog("GEOFENCE", `${dev} 진입 → 건너뜀: 유효한 출입 토큰 없음`);
      return;
    }
    authLog("GEOFENCE", `${dev} 진입 → BLE 추적 시작`);
    // 루프가 끝날 때까지 태스크를 끝내지 않는다. 앱 프로세스가 죽은 상태에서 headless로 깬 경우,
    // expo-task-manager는 태스크가 끝나고 2초 뒤 JS 런타임을 내리므로 그대로 두면 루프가 함께 죽는다.
    await startBleTracking(device, enteredAt);
  } else if (eventType === Location.LocationGeofencingEventType.Exit) {
    appendSystemLog({ event_name: uuid, log_type: "INFO", message: "geofence exit" });
    authLog("GEOFENCE", `${dev} 이탈${bleInProgress.has(uuid) ? " → BLE 추적 중단" : ""} · 인증 기록 초기화`);
    await updateDeviceStatus((list) => {
      const status = list.find((s) => s.device_uuid === uuid);
      if (status) {
        status.isInside = false;
        status.bleSuccess = false;
      }
      return list;
    });
    stopBleTracking(uuid, "지오펜스 이탈");
  }
});
