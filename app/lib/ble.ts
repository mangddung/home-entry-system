import { requestBluetoothPermission } from "@/hooks/request-ble-permit";
import { DEBUG_LOG, DEVICE_STATUS_KEY, USER_SECRET_KEY, USER_UUID_KEY } from "@/lib/constants";
import { encryptAES, sha256 } from "@/lib/crypto";
import { appendSystemLog, formatTimestamp } from "@/lib/system-log";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Buffer } from "buffer";
import { BleManager, Device, ScanMode } from "react-native-ble-plx";
import { getTokenSecure, setTokenSecure } from "./token-storage";
import { DebugLog, DeviceStatus, IoTDevice } from "./types";

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

export type ScanOptions = { scanMode?: ScanMode; timeoutMs?: number };

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

  isScanning = true;
  const found = new Map<string, Device>();

  return new Promise<Device[]>((resolve) => {
    const scanTimeout = setTimeout(() => {
      manager.stopDeviceScan();
      isScanning = false;
      logDebug({
        event_name: event_name,
        log_type: "DEBUG",
        message: `스캔 완료: ${found.size}개 발견`,
      });
      resolve([...found.values()]);
    }, opts?.timeoutMs ?? 30000);

    manager.startDeviceScan([bleUuids.ble_service_uuid], { scanMode: opts?.scanMode ?? ScanMode.LowLatency }, async (error, device) => {
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

export const connectDevice = async (device: Device, tryCount: any = 0): Promise<Device | null> => {
  let connected: Device | null = null;
  while (tryCount < 5) {
    try {
      connected = await device.connect();
      break;
    } catch (e: any) {
      tryCount++;
      logDebug({ event_name, log_type: "WARNING", message: `실패 재시도(${tryCount}회): ${e.message}` });
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
    const userUuid = await getTokenSecure(USER_UUID_KEY);
    const bleEncryptionKey = await getTokenSecure(USER_SECRET_KEY);
    if (!userUuid || !bleEncryptionKey) {
      logDebug({
        event_name: event_name,
        log_type: "WARNING",
        message: "user uuid, secret key 없음",
      });
      return false;
    }
    const payload = {
      nonce: nonce,
      timestamp: new Date().toISOString(),
      auth_token: ioTDevice.auth_token?.token_value,
    };

    const encryptedData = encryptAES(JSON.stringify(payload), bleEncryptionKey);
    const encodedData = Buffer.from(userUuid + ":" + encryptedData, "utf-8").toString("base64");
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

    // device status 변경
    const storedDeviceStatus: string | null = await getTokenSecure(DEVICE_STATUS_KEY);
    const parsedDeviceStatus: DeviceStatus[] = storedDeviceStatus
      ? JSON.parse(storedDeviceStatus)
      : [];
    parsedDeviceStatus.forEach((deviceStatus) => {
      deviceStatus.bleSuccess = deviceStatus.device_uuid === ioTDevice.device_uuid;
    });
    await setTokenSecure(DEVICE_STATUS_KEY, JSON.stringify(parsedDeviceStatus));
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
  const user_uuid = await getTokenSecure(USER_UUID_KEY);
  if (!user_uuid) return;
  const payload = {
    setup_token: setup_token,
    wifi_ssid: wifi_ssid,
    wifi_pw: wifi_pw,
    user_uuid: user_uuid,
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
  } catch (e) {
    logDebug({
      event_name: event_name,
      log_type: "WARNING",
      message: `WIfi 셋업 전송 실패: ${e}`,
    });
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
