import { requestBluetoothPermission } from "@/hooks/request-ble-permit";
import { updateDeviceStatus } from "@/lib/api/devices";
import { DEBUG_LOG, USER_SECRET_KEY } from "@/lib/constants";
import { hmacSha256, sha256 } from "@/lib/crypto";
import { createGate } from "@/lib/proximity-rules";
import { appendSystemLog, formatTimestamp } from "@/lib/system-log";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Buffer } from "buffer";
import { BleManager, Device, ScanMode } from "react-native-ble-plx";
import { getTokenSecure } from "./token-storage";
import { DebugLog, IoTDevice } from "./types";

const event_name = "[BLE]";

const manager = new BleManager();
let isScanning = false;

export const logDebug = async (debugLog: Omit<DebugLog, "timestamp">) => {
  const raw = await AsyncStorage.getItem(DEBUG_LOG);
  const parsed: DebugLog[] = raw ? JSON.parse(raw) : [];
  parsed.push({ timestamp: formatTimestamp(new Date()), ...debugLog });
  // 최근 200개만 유지
  const trimmed = parsed.length > 200 ? parsed.slice(parsed.length - 200) : parsed;
  await AsyncStorage.setItem(DEBUG_LOG, JSON.stringify(trimmed));
};

const waitForPoweredOn = (manager: BleManager): Promise<void> =>
  new Promise((resolve, reject) => {
    const sub = manager.onStateChange((state) => {
      if (state === "PoweredOn") {
        sub.remove();
        resolve();
      } else if (state === "PoweredOff" || state === "Unsupported") {
        sub.remove();
        reject(new Error(`BLE 상태: ${state}`));
      }
    }, true);
  });

export const stopScan = () => {
  if (isScanning) {
    manager.stopDeviceScan();
    isScanning = false;
  }
};

// 디버그 탭 RSSI 측정용: 주어진 서비스 UUID들의 광고를 연결 없이 계속 받는다.
// 다른 스캔(백그라운드 트래킹 등) 중이면 null. 반환된 함수로 중지한다.
export const startRssiScan = async (
  serviceUuids: string[],
  onAdvertise: (serviceUuid: string, rssi: number) => void,
): Promise<(() => void) | null> => {
  if (isScanning) return null;
  if (!(await requestBluetoothPermission())) return null;
  await waitForPoweredOn(manager);

  const targets = new Set(serviceUuids.map((u) => u.toLowerCase()));
  const stop = () => {
    manager.stopDeviceScan();
    isScanning = false;
  };
  if (isScanning) return null; // await 사이에 다른 스캔이 시작됐으면 겹치지 않게 물러난다(scanDevice 주석 참고)
  isScanning = true;
  // Android는 LowLatency에서 광고마다 콜백, iOS는 allowDuplicates가 있어야 반복 수신된다
  manager.startDeviceScan([...targets], { scanMode: ScanMode.LowLatency, allowDuplicates: true }, (error, device) => {
    if (error) {
      logDebug({ event_name, log_type: "WARNING", message: `RSSI 스캔 에러: ${error.message}` });
      stop();
      return;
    }
    if (!device || device.rssi == null) return;
    const matched = device.serviceUUIDs?.map((u) => u.toLowerCase()).find((u) => targets.has(u));
    if (matched) onAdvertise(matched, device.rssi);
  });
  return stop;
};

export type ScanOptions = {
  scanMode?: ScanMode;
  timeoutMs?: number;
  // 근접 해제: 광고 RSSI 중앙값이 문턱을 연속으로 넘을 때만 기기를 돌려준다(못 넘으면 빈 배열).
  // onTrigger는 넘은 순간의 중앙값으로 한 번 불린다.
  gate?: { threshold: number; onTrigger?: (rssi: number) => void };
};

export const scanDevice = async (
  ioTDevice: IoTDevice,
  onDeviceFound?: (device: Device) => void,
  opts?: ScanOptions,
): Promise<Device[]> => {
  if (isScanning) {
    logDebug({ event_name: event_name, log_type: "DEBUG", message: "이미 스캔 중, 건너뜀" });
    return [];
  }

  logDebug({
    event_name: event_name,
    log_type: "DEBUG",
    message: `BLE 트래킹 시작: ${ioTDevice.device_uuid}`,
  });

  const granted = await requestBluetoothPermission();
  if (!granted) {
    logDebug({ event_name: event_name, log_type: "WARNING", message: "BLE 권한 거부됨" });
    return [];
  }

  const bleUuids = ioTDevice.ble_uuids;
  if (!bleUuids.ble_service_uuid || !bleUuids.ble_read_uuid || !bleUuids.ble_write_uuid) {
    logDebug({ event_name: event_name, log_type: "WARNING", message: "BLE UUID 누락" });
    return [];
  }

  try {
    await waitForPoweredOn(manager);
  } catch (e: any) {
    logDebug({ event_name: event_name, log_type: "WARNING", message: e.message });
    return [];
  }

  logDebug({
    event_name: event_name,
    log_type: "DEBUG",
    message: `스캔 시작 (service UUID: ${bleUuids.ble_service_uuid})`,
  });

  // 위 await 사이에 다른 호출(겹친 지오펜스의 다른 기기 루프 등)이 먼저 스캔을 시작했을 수 있다.
  // ble-plx는 새 스캔이 이전 스캔을 멈추지 않아 두 번 시작하면 리스너·네이티브 스캔이 새고 다른 기기 광고가 섞인다.
  // 여기서 startDeviceScan까지는 await가 없어 확인과 세팅 사이에 끼어들 수 없다.
  if (isScanning) return [];
  isScanning = true;
  const found = new Map<string, Device>();
  const gate = opts?.gate ? createGate(opts.gate.threshold) : null;
  let gated = false;

  return new Promise<Device[]>((resolve) => {
    const scanTimeout = setTimeout(() => {
      manager.stopDeviceScan();
      isScanning = false;
      logDebug({
        event_name: event_name,
        log_type: "DEBUG",
        message: gate ? `근접 문턱 미달로 스캔 종료 (${found.size}개 발견)` : `스캔 완료: ${found.size}개 발견`,
      });
      // 게이트 사용 시 발견만 하고 문턱을 못 넘었으면 연결하지 않는다
      resolve(gate ? [] : [...found.values()]);
    }, opts?.timeoutMs ?? 30000);

    // 게이트는 같은 기기의 광고를 반복해서 받아야 한다(iOS는 allowDuplicates 필요, Android는 LowLatency에서 매번 콜백)
    manager.startDeviceScan([bleUuids.ble_service_uuid], { scanMode: opts?.scanMode ?? ScanMode.LowLatency, allowDuplicates: !!gate }, async (error, device) => {
      if (error) {
        clearTimeout(scanTimeout);
        manager.stopDeviceScan();
        isScanning = false;
        logDebug({
          event_name: event_name,
          log_type: "WARNING",
          message: `스캔 에러: ${error.message}`,
        });
        resolve([]);
        return;
      }
      if (device && gate) {
        found.set(device.id, device);
        if (gated || device.rssi == null) return;
        const hit = gate(device.rssi);
        if (hit == null) return;
        gated = true;
        clearTimeout(scanTimeout);
        manager.stopDeviceScan();
        isScanning = false;
        logDebug({ event_name, log_type: "DEBUG", message: `근접 트리거: RSSI ${hit} ≥ ${opts!.gate!.threshold}` });
        opts!.gate!.onTrigger?.(hit);
        resolve([device]);
        return;
      }
      if (device) {
        const isNew = !found.has(device.id);
        found.set(device.id, device);
        if (isNew) {
          await logDebug({
            event_name: event_name,
            log_type: "DEBUG",
            message: `디바이스 발견: ${device.id}`,
          });
          if (!onDeviceFound) {
            clearTimeout(scanTimeout);
            manager.stopDeviceScan();
            isScanning = false;
            resolve([...found.values()]);
            return;
          }
        }
        onDeviceFound?.(device);
      }
    });
  });
};

// shouldAbort: 대기 중인 connect는 OS 타임아웃(약 30초)까지 안 끝나므로, true가 되면 직접 취소하고 재시도도 멈춘다
export const connectDevice = async (
  device: Device,
  tryCount: any = 0,
  shouldAbort?: () => boolean,
): Promise<Device | null> => {
  let connected: Device | null = null;
  let aborted = false;
  while (tryCount < 5 && !aborted) {
    const watch = shouldAbort && setInterval(() => {
      if (!shouldAbort()) return;
      aborted = true;
      manager.cancelDeviceConnection(device.id).catch(() => {});
    }, 500);
    try {
      connected = await device.connect();
      break;
    } catch (e: any) {
      tryCount++;
      logDebug({ event_name, log_type: "WARNING", message: `실패 재시도(${tryCount}회): ${e.message}` });
    } finally {
      if (watch) clearInterval(watch);
    }
  }

  if (!connected) return null;

  await new Promise((r) => setTimeout(r, 600));

  try { await connected.requestMTU(512); } catch {}

  try {
    await connected.discoverAllServicesAndCharacteristics();
    return connected;
  } catch (e: any) {
    logDebug({ event_name, log_type: "WARNING", message: `서비스 탐색 실패: ${e.message}` });
    return null;
  }
};

// READ_ENC 특성 읽기 시도 → 암호화 미설정이면 Android이 페어링 시작 (팝업 1개)
export const triggerPairing = async (device: Device, ioTDevice: IoTDevice): Promise<void> => {
  const { ble_service_uuid, ble_read_uuid } = ioTDevice.ble_uuids;
  if (!ble_service_uuid || !ble_read_uuid) return;
  try {
    await device.readCharacteristicForService(ble_service_uuid, ble_read_uuid);
  } catch {
    // 암호화 미설정 시 오류는 정상 — Android이 페어링을 시작함
  }
};

// 기기 선택 시 GATT 임시 연결 + 키 교환
export const receiveData = (connected: Device, ioTDevice: IoTDevice): Promise<string | null> => {
  const bleUuids = ioTDevice.ble_uuids;

  return new Promise((resolve) => {
    try {
      logDebug({ event_name: event_name, log_type: "DEBUG", message: "연결됨 - 키 교환 중..." });
      connected.monitorCharacteristicForService(
        bleUuids.ble_service_uuid as string,
        bleUuids.ble_read_uuid as string,
        (err, char) => {
          if (err || !char?.value) {
            resolve(null);
            return;
          }
          const nonce = Buffer.from(char.value, "base64").toString("utf-8");
          logDebug({
            event_name: event_name,
            log_type: "DEBUG",
            message: `Nonce received: ${nonce}`,
          });
          resolve(nonce);
        },
      );
    } catch (e: any) {
      logDebug({ event_name: event_name, log_type: "DEBUG", message: "nonce 수신 실패" });
      resolve(null);
    }
  });
};

export const sendUserAuthToken = async (connected: any, ioTDevice: IoTDevice, nonce: any): Promise<boolean> => {
  const bleUuids = ioTDevice.ble_uuids;
  // 앱 -> ESP 데이터 전송
  try {
    const bleEncryptionKey = await getTokenSecure(USER_SECRET_KEY);
    if (!bleEncryptionKey) {
      logDebug({
        event_name: event_name,
        log_type: "WARNING",
        message: "secret key 없음",
      });
      return false;
    }
    // 토큰 원문은 보내지 않는다. 서버가 ESP에게 받은 nonce로 같은 mac을 다시 계산해 비교한다.
    const mac = hmacSha256(nonce + (ioTDevice.auth_token?.token_value ?? ""), bleEncryptionKey);
    const encodedData = Buffer.from(mac, "utf-8").toString("base64");
    await connected.writeCharacteristicWithoutResponseForService(
      bleUuids.ble_service_uuid as string,
      bleUuids.ble_write_uuid as string,
      encodedData,
    );
    await connected.cancelConnection();
    logDebug({
      event_name: event_name,
      log_type: "DEBUG",
      message: `전송 완료: ${encodedData}`,
    });
    appendSystemLog({
      event_name: event_name,
      log_type: "DEBUG",
      message: `전송 완료: ${encodedData}`,
    });
    // 검증 완료 response 추가 예정

    // device status 변경. 다른 기기 기록은 건드리지 않는다(이탈 시 각자 초기화된다).
    // 겹친 지오펜스에서 먼저 연 기기의 성공 기록을 지우면 재등록 시 initial Enter로 그 기기가 다시 열린다.
    await updateDeviceStatus((list) => {
      const status = list.find((s) => s.device_uuid === ioTDevice.device_uuid);
      if (status) status.bleSuccess = true;
      return list;
    });
    return true;
  } catch (e: any) {
    logDebug({
      event_name: event_name,
      log_type: "WARNING",
      message: `암호화/전송 실패: ${e}`,
    });
    return false;
  }
};

export const sendSetupCode = async (
  connected: any,
  ioTDevice: IoTDevice,
  nonce: any,
  setupCode: any,
) => {
  const bleUuids = ioTDevice.ble_uuids;
  const hashedData = sha256(setupCode + nonce);
  const encodedData = Buffer.from(hashedData, "utf-8").toString("base64");
  logDebug({
    event_name: event_name,
    log_type: "DEBUG",
    message: `hashed data: ${hashedData}`,
  });

  try {
    await connected.writeCharacteristicWithoutResponseForService(
      bleUuids.ble_service_uuid as string,
      bleUuids.ble_write_uuid as string,
      encodedData,
    );
  } catch (e) {
    logDebug({
      event_name: event_name,
      log_type: "WARNING",
      message: `해쉬 전송 실패: ${e}`,
    });
  }
};

export const sendWifiSetup = async (
  connected: any,
  ioTDevice: IoTDevice,
  wifi_ssid: any,
  wifi_pw: any,
  setup_token: any,
) => {
  const bleUuids = ioTDevice.ble_uuids;
  // 펌웨어는 세 필드 모두 문자열이어야 파싱한다. 하나라도 문자열이 아니면
  // JSON 자체는 유효해서 cJSON_Parse를 통과한 뒤 "missing JSON fields"로 죽는다.
  if (
    typeof setup_token !== "string" ||
    typeof wifi_ssid !== "string" ||
    typeof wifi_pw !== "string" ||
    !setup_token
  ) {
    logDebug({
      event_name: event_name,
      log_type: "WARNING",
      message: `잘못된 setup payload: setup_token=${typeof setup_token}, wifi_ssid=${typeof wifi_ssid}, wifi_pw=${typeof wifi_pw}`,
    });
    return false;
  }
  const payload = {
    setup_token: setup_token,
    wifi_ssid: wifi_ssid,
    wifi_pw: wifi_pw,
  };
  const encodedData = Buffer.from(JSON.stringify(payload), "utf-8").toString("base64");
  logDebug({
    event_name: event_name,
    log_type: "DEBUG",
    message: `payload data: ${payload}`,
  });

  try {
    await connected.writeCharacteristicWithoutResponseForService(
      bleUuids.ble_service_uuid as string,
      bleUuids.ble_write_uuid as string,
      encodedData,
    );
    return true;
  } catch (e) {
    logDebug({
      event_name: event_name,
      log_type: "WARNING",
      message: `WIfi 셋업 전송 실패: ${e}`,
    });
    return false;
  }
};

export const userTokenExchange = async (ioTDevice: IoTDevice, opts?: ScanOptions): Promise<boolean> => {
  const devices = await scanDevice(ioTDevice, undefined, opts);
  if (!devices.length) return false;
  const connected = await connectDevice(devices[0]);
  if (!connected) return false;
  const nonce = await receiveData(connected, ioTDevice);
  if (nonce == null) return false;
  return await sendUserAuthToken(connected, ioTDevice, nonce);
};
