import { requestBluetoothPermission } from "@/hooks/request-ble-permit";
import { requestBleGrant, signServoCommand, updateDeviceStatus } from "@/lib/api/devices";
import { commitBond, dropPendingBond, hasBond, markPendingBond, resetBond, unbondDevice } from "@/lib/bond";
import { DEBUG_LOG, USER_SECRET_KEY } from "@/lib/constants";
import { hmacSha256, sha256 } from "@/lib/crypto";
import { createGate } from "@/lib/proximity-rules";
import { bgSleep, clearBgTimeout, setBgTimeout } from "@/modules/activity-transition";
import { appendSystemLog, formatTimestamp } from "@/lib/system-log";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Buffer } from "buffer";
import { BleManager, ConnectionOptions, ConnectionPriority, Device, ScanMode } from "react-native-ble-plx";
import { getTokenSecure } from "./token-storage";
import { DebugLog, IoTDevice, Transport } from "./types";

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

// Unauthorized·Unknown·Resetting에 머물면 영영 끝나지 않으므로 상한을 둔다(백그라운드 루프가 멈추지 않게)
const POWER_ON_TIMEOUT_MS = 10000;
const waitForPoweredOn = (manager: BleManager): Promise<void> =>
  new Promise((resolve, reject) => {
    let last = "Unknown";
    const timer = setBgTimeout(() => {
      sub.remove();
      reject(new Error(`BLE 상태: ${last} (${POWER_ON_TIMEOUT_MS / 1000}초 동안 켜지지 않음)`));
    }, POWER_ON_TIMEOUT_MS);
    const sub = manager.onStateChange((state) => {
      last = state;
      if (state === "PoweredOn") {
        clearBgTimeout(timer);
        sub.remove();
        resolve();
      } else if (state === "PoweredOff" || state === "Unsupported") {
        clearBgTimeout(timer);
        sub.remove();
        reject(new Error(`BLE 상태: ${state}`));
      }
    }, true);
  });

// 광고 manufacturer data = [company ID 0x02E5 little-endian][모델 코드 1=Wi-Fi, 2=Zigbee] (esp32/main/ble_server.c)
// 펌웨어가 모델 코드를 싣기 전 기기는 null
export const advertisedModel = (device: Device): Transport | null => {
  if (!device.manufacturerData) return null;
  const b = Buffer.from(device.manufacturerData, "base64");
  if (b.length < 3 || b[0] !== 0xe5 || b[1] !== 0x02) return null;
  return b[2] === 2 ? "zigbee" : b[2] === 1 ? "wifi" : null;
};

// 진행 중인 scanDevice를 끝낸다(타임아웃 해제 + 결과 반환). 타임아웃을 남겨 두면 나중에 다른 스캔을 멈춘다.
let finishActiveScan: (() => void) | null = null;

export const stopScan = () => {
  if (finishActiveScan) {
    finishActiveScan();
  } else if (isScanning) {
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
  // 자동 인증 디버그 로그용. 스캔·연결·nonce·전송 단계마다 한 줄씩 받는다(lib/auth-log.ts)
  trace?: (message: string) => void;
};

export const scanDevice = async (
  ioTDevice: IoTDevice,
  onDeviceFound?: (device: Device) => void,
  opts?: ScanOptions,
): Promise<Device[]> => {
  const trace = opts?.trace;
  if (isScanning) {
    logDebug({ event_name: event_name, log_type: "DEBUG", message: "이미 스캔 중, 건너뜀" });
    trace?.("스캔 건너뜀: 다른 스캔(화면의 BLE 디버그·보정·등록 등)이 진행 중");
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
    trace?.("스캔 불가: 근처 기기/위치 권한 없음");
    return [];
  }

  const bleUuids = ioTDevice.ble_uuids;
  if (!bleUuids.ble_service_uuid || !bleUuids.ble_read_uuid || !bleUuids.ble_write_uuid) {
    logDebug({ event_name: event_name, log_type: "WARNING", message: "BLE UUID 누락" });
    trace?.("스캔 불가: BLE UUID 누락");
    return [];
  }

  try {
    await waitForPoweredOn(manager);
  } catch (e: any) {
    logDebug({ event_name: event_name, log_type: "WARNING", message: e.message });
    trace?.(`스캔 불가: ${e.message}`);
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
  // 디버그 로그용 광고 통계
  const startedAt = Date.now();
  let samples = 0;
  let maxRssi: number | null = null;
  let lastRssi: number | null = null;
  let firstSeenMs: number | null = null;
  const mode = opts?.scanMode === ScanMode.LowLatency || opts?.scanMode == null ? "빠른" : "절전";
  trace?.(`스캔 시작 (${mode} 모드, ${(opts?.timeoutMs ?? 30000) / 1000}초${gate ? `, 문턱 ${opts!.gate!.threshold}dBm` : ", 문턱 없음 = 발견 즉시"})`);

  return new Promise<Device[]>((resolve) => {
    let done = false;
    // 끝나는 경로(시간 초과·에러·발견·문턱 통과·stopScan)는 전부 여기로 모아 타임아웃을 함께 정리한다
    const finish = (result: Device[], reason: string) => {
      if (done) return;
      done = true;
      clearBgTimeout(scanTimeout);
      manager.stopDeviceScan();
      isScanning = false;
      if (finishActiveScan === stopThis) finishActiveScan = null;
      const stats = samples
        ? `광고 ${samples}회, 최대 ${maxRssi}dBm, 마지막 ${lastRssi}dBm, 처음 발견 ${firstSeenMs}ms`
        : "광고 수신 없음";
      trace?.(`스캔 종료: ${reason} · ${Date.now() - startedAt}ms · ${stats}`);
      resolve(result);
    };
    const stopThis = () => finish(gate ? [] : [...found.values()], "중지 요청");
    finishActiveScan = stopThis;

    const scanTimeout = setBgTimeout(() => {
      logDebug({
        event_name: event_name,
        log_type: "DEBUG",
        message: gate ? `근접 문턱 미달로 스캔 종료 (${found.size}개 발견)` : `스캔 완료: ${found.size}개 발견`,
      });
      // 게이트 사용 시 발견만 하고 문턱을 못 넘었으면 연결하지 않는다
      finish(gate ? [] : [...found.values()], gate ? (samples ? "문턱 미달 시간 초과" : "미발견 시간 초과") : "시간 초과");
    }, opts?.timeoutMs ?? 30000);

    // 게이트는 같은 기기의 광고를 반복해서 받아야 한다(iOS는 allowDuplicates 필요, Android는 LowLatency에서 매번 콜백)
    manager.startDeviceScan([bleUuids.ble_service_uuid], { scanMode: opts?.scanMode ?? ScanMode.LowLatency, allowDuplicates: !!gate }, async (error, device) => {
      if (done) return;
      if (error) {
        logDebug({
          event_name: event_name,
          log_type: "WARNING",
          message: `스캔 에러: ${error.message}`,
        });
        finish([], `스캔 에러: ${error.message}`);
        return;
      }
      if (device?.rssi != null) {
        samples++;
        lastRssi = device.rssi;
        maxRssi = maxRssi == null ? device.rssi : Math.max(maxRssi, device.rssi);
        if (firstSeenMs == null) firstSeenMs = Date.now() - startedAt;
      }
      if (device && gate) {
        found.set(device.id, device);
        if (gated || device.rssi == null) return;
        const hit = gate(device.rssi);
        if (hit == null) return;
        gated = true;
        logDebug({ event_name, log_type: "DEBUG", message: `근접 트리거: RSSI ${hit} ≥ ${opts!.gate!.threshold}` });
        opts!.gate!.onTrigger?.(hit);
        finish([device], `문턱 통과 (중앙값 ${hit}dBm ≥ ${opts!.gate!.threshold}dBm)`);
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
            finish([...found.values()], `발견 (RSSI ${device.rssi ?? "?"}dBm)`);
            return;
          }
        }
        onDeviceFound?.(device);
      }
    });
  });
};

// 마지막 연결 실패 사유. 자동 인증 로그의 "연결 실패" 줄에 붙인다
let lastConnectError = "";

// shouldAbort: 대기 중인 connect는 OS 타임아웃(약 30초)까지 안 끝나므로, true가 되면 직접 취소하고 재시도도 멈춘다
export const connectDevice = async (
  device: Device,
  tryCount: any = 0,
  shouldAbort?: () => boolean,
  options?: ConnectionOptions,
): Promise<Device | null> => {
  let connected: Device | null = null;
  let aborted = false;
  while (tryCount < 5 && !aborted) {
    // 0.5초마다 중단 요청을 확인한다(setInterval 대신 백그라운드 타이머를 이어 건다)
    let watch: number | null = null;
    const poll = () => {
      watch = setBgTimeout(() => {
        if (!shouldAbort?.()) return poll();
        aborted = true;
        manager.cancelDeviceConnection(device.id).catch(() => {});
      }, 500);
    };
    if (shouldAbort) poll();
    try {
      connected = await device.connect(options);
      break;
    } catch (e: any) {
      tryCount++;
      lastConnectError = `${tryCount}회째 ${e.message}`;
      logDebug({ event_name, log_type: "WARNING", message: `실패 재시도(${tryCount}회): ${e.message}` });
    } finally {
      if (watch != null) clearBgTimeout(watch);
    }
  }

  if (!connected) return null;

  await bgSleep(600);

  try { await connected.requestMTU(512); } catch {}

  try {
    await connected.discoverAllServicesAndCharacteristics();
    // 셋업·일반 모드는 주소가 같고 특성 표가 다르다. 본딩한 폰은 Android가 표를 캐시해서 등록 직후 첫 연결에 옛 표가 나온다.
    // 광고한 서비스가 표에 없으면 캐시를 버리고 한 번 다시 연결한다.
    const advertised = device.serviceUUIDs?.[0]?.toLowerCase();
    if (advertised && !options?.refreshGatt) {
      const services = await connected.services();
      if (!services.some((s) => s.uuid.toLowerCase() === advertised)) {
        await connected.cancelConnection().catch(() => {});
        return connectDevice(device, 0, shouldAbort, { ...options, refreshGatt: "OnConnected" });
      }
    }
    return connected;
  } catch (e: any) {
    lastConnectError = `서비스 탐색 실패: ${e.message}`;
    logDebug({ event_name, log_type: "WARNING", message: `서비스 탐색 실패: ${e.message}` });
    // 연결은 된 상태라 직접 끊는다(ESP는 연결 하나만 받으므로 남겨 두면 다음 시도에서 안 보인다)
    await connected.cancelConnection().catch(() => {});
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

// nonce 알림 대기 상한. 펌웨어 nonce 유효 시간(8초)보다 조금 길게 잡는다.
// 상한이 없으면 알림이 안 올 때(본딩 풀림 등) 펌웨어가 연결을 끊을 때까지 루프가 멈춘다.
const NONCE_TIMEOUT_MS = 10000;
// 셋업 결과 대기 상한. 펌웨어 Zigbee 가입 60초 + 서버 응답 60초(ZB_SETUP_JOIN_MS, ZB_SETUP_SERVER_MS)보다 길게 잡는다.
export const SETUP_RESULT_TIMEOUT_MS = 130000;

// 기기 선택 시 GATT 임시 연결 + 키 교환
// 구독은 따로 해제하지 않는다(해제가 펌웨어 nonce 상태에 영향을 줄 수 있다). 연결을 끊으면 함께 정리된다.
export const receiveData = (
  connected: Device,
  ioTDevice: IoTDevice,
  timeoutMs: number = NONCE_TIMEOUT_MS,
): Promise<string | null> => {
  const bleUuids = ioTDevice.ble_uuids;

  return new Promise((resolve) => {
    let done = false;
    const finish = (nonce: string | null) => {
      if (done) return;
      done = true;
      clearBgTimeout(timer);
      resolve(nonce);
    };
    const timer = setBgTimeout(() => {
      logDebug({ event_name: event_name, log_type: "WARNING", message: "nonce 수신 시간 초과" });
      finish(null);
    }, timeoutMs);
    try {
      logDebug({ event_name: event_name, log_type: "DEBUG", message: "연결됨 - 키 교환 중..." });
      connected.monitorCharacteristicForService(
        bleUuids.ble_service_uuid as string,
        bleUuids.ble_read_uuid as string,
        (err, char) => {
          if (err || !char?.value) {
            finish(null);
            return;
          }
          const nonce = Buffer.from(char.value, "base64").toString("utf-8");
          logDebug({
            event_name: event_name,
            log_type: "DEBUG",
            message: `Nonce received: ${nonce}`,
          });
          finish(nonce);
        },
      );
    } catch (e: any) {
      logDebug({ event_name: event_name, log_type: "DEBUG", message: "nonce 수신 실패" });
      finish(null);
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
  return writeSetupPayload(connected, ioTDevice, {
    setup_token: setup_token,
    wifi_ssid: wifi_ssid,
    wifi_pw: wifi_pw,
  });
};

// Zigbee 모델: Wi-Fi 정보 없이 셋업 토큰만 보낸다. 기기는 게이트웨이 네트워크에 가입해 서버에 확인한다.
export const sendZigbeeSetup = async (connected: any, ioTDevice: IoTDevice, setup_token: string) => {
  if (!setup_token) return false;
  return writeSetupPayload(connected, ioTDevice, { setup_token });
};

const writeSetupPayload = async (connected: any, ioTDevice: IoTDevice, payload: Record<string, string>) => {
  const bleUuids = ioTDevice.ble_uuids;
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
      message: `셋업 정보 전송 실패: ${e}`,
    });
    return false;
  }
};

// 기기가 서버 검증 결과로 보내는 알림. esp32/main/ble_server.h ble_server_auth_result와 짝
const AUTH_RESULT_PATTERN = /^AUTH_(OK|DENY|NET_FAIL)$/;
// 펌웨어 최악: HTTP 10초 × 2회 + 그 사이 재인증 요청
const AUTH_RESULT_TIMEOUT_MS = 35000;

// ok: 문 열림 / denied: 서버가 거부(다시 해도 같음) / server_fail: 기기가 서버에 닿지 못함 / failed: 기기와 통신 실패
export type AuthOutcome = "ok" | "denied" | "server_fail" | "failed";

export const AUTH_OUTCOME_MESSAGE: Record<AuthOutcome, { title: string; message: string }> = {
  ok: { title: "수동 인증", message: "문이 열렸습니다." },
  denied: { title: "인증 거부", message: "기기가 인증을 거부했습니다. 출입 토큰 상태를 확인하세요." },
  server_fail: { title: "오류", message: "기기가 서버에 연결하지 못했습니다. 잠시 후 다시 시도하세요." },
  failed: { title: "오류", message: "기기에 연결할 수 없습니다. 기기가 오프라인 상태이거나 범위 밖에 있는지 확인하세요." },
};

export const userTokenExchange = async (ioTDevice: IoTDevice, opts?: ScanOptions): Promise<AuthOutcome> => {
  const trace = opts?.trace;
  const t0 = Date.now();
  const devices = await scanDevice(ioTDevice, undefined, opts);
  if (!devices.length) return "failed";
  const tScan = Date.now();
  trace?.(`연결 시도 (RSSI ${devices[0].rssi ?? "?"}dBm)`);
  lastConnectError = "";
  const connected = await connectDevice(devices[0]);
  if (!connected) {
    trace?.(`연결 실패 (${Date.now() - tScan}ms): ${lastConnectError || "사유 없음"}`);
    return "failed";
  }
  const tConn = Date.now();
  // nonce와 검증 결과 두 번 알림을 받으므로 1회용 receiveData 대신 수신함을 쓴다
  const inbox = openInbox(connected, ioTDevice);
  try {
    const nonce = await inbox.waitFor(NONCE_PATTERN, NONCE_TIMEOUT_MS);
    if (nonce == null) {
      trace?.(`nonce 수신 실패 또는 ${NONCE_TIMEOUT_MS / 1000}초 초과 (연결 ${tConn - tScan}ms)`);
      return "failed";
    }
    const tNonce = Date.now();
    if (!(await sendUserAuthToken(connected, ioTDevice, nonce))) {
      trace?.("응답값 전송 실패");
      return "failed";
    }
    const tSent = Date.now();
    const result = await inbox.waitFor(AUTH_RESULT_PATTERN, AUTH_RESULT_TIMEOUT_MS);
    const outcome: AuthOutcome =
      result === "AUTH_OK" ? "ok" : result === "AUTH_DENY" ? "denied" : result === "AUTH_NET_FAIL" ? "server_fail" : "failed";
    trace?.(
      `${result ?? `결과 없음(${AUTH_RESULT_TIMEOUT_MS / 1000}초 초과 또는 연결 끊김)`}` +
        ` · 스캔 ${tScan - t0}ms / 연결 ${tConn - tScan}ms / nonce ${tNonce - tConn}ms / 서버 결과 ${Date.now() - tSent}ms`,
    );
    if (outcome === "ok") {
      // 다른 기기 기록은 건드리지 않는다(이탈 시 각자 초기화된다).
      // 겹친 지오펜스에서 먼저 연 기기의 성공 기록을 지우면 재등록 시 initial Enter로 그 기기가 다시 열린다.
      await updateDeviceStatus((list) => {
        const status = list.find((s) => s.device_uuid === ioTDevice.device_uuid);
        if (status) status.bleSuccess = true;
        return list;
      });
    }
    return outcome;
  } finally {
    inbox.close();
    // 남겨 두면 ESP 인증 타이머가 끊을 때까지 단일 연결을 점유해 광고가 멈추고 다음 스캔에서 안 보인다.
    await connected.cancelConnection().catch(() => {});
  }
};

const SERVO_SCAN_TIMEOUT_MS = 10000;
// 서보 실시간 조절 특성. esp32/main/ble_server.c SERVO_LIVE_CHR_UUID와 짝
const SERVO_LIVE_CHR_UUID = "a3f1c6e2-5b7d-4e19-8c42-7d9e0b36f1a8";
const NONCE_PATTERN = /^[0-9a-f]{16}$/;
const REPLY_TIMEOUT_MS = 8000;
const BOND_RESULT_TIMEOUT_MS = 30000; // 펌웨어 BOND_WINDOW_MS와 같은 값
// 펌웨어 특성 표가 바뀌었으므로 본딩한 폰이 캐시한 옛 GATT를 버리고 다시 읽는다
const SESSION_CONNECT_OPTIONS: ConnectionOptions = { refreshGatt: "OnConnected" };

// 연결을 유지하는 흐름의 알림 수신함. receiveData는 1회용이라 알림이 여러 번 오면 쓸 수 없다.
// 보낸 순서와 도착 순서가 어긋나도 되도록 형식으로 골라 꺼낸다.
const openInbox = (connected: Device, ioTDevice: IoTDevice) => {
  const inbox: string[] = [];
  const waiters = new Set<{ pattern: RegExp; deliver: (message: string | null) => void }>();
  let closed = false;

  const subscription = connected.monitorCharacteristicForService(
    ioTDevice.ble_uuids.ble_service_uuid,
    ioTDevice.ble_uuids.ble_read_uuid,
    (err, char) => {
      // 연결이 끊기면 구독이 오류로 끝난다. 남은 대기는 시간 초과까지 기다리지 않고 바로 null로 끝낸다.
      if (err) {
        closed = true;
        [...waiters].forEach((w) => w.deliver(null));
        return;
      }
      if (!char?.value) return;
      const message = Buffer.from(char.value, "base64").toString("utf-8");
      const waiter = [...waiters].find((w) => w.pattern.test(message));
      if (waiter) waiter.deliver(message);
      else inbox.push(message);
    },
  );

  const waitFor = (pattern: RegExp, timeoutMs = REPLY_TIMEOUT_MS) =>
    new Promise<string | null>((resolve) => {
      const index = inbox.findIndex((m) => pattern.test(m));
      if (index >= 0) {
        resolve(inbox.splice(index, 1)[0]);
        return;
      }
      if (closed) {
        resolve(null);
        return;
      }
      const waiter = {
        pattern,
        deliver: (message: string | null) => {
          clearBgTimeout(timer);
          waiters.delete(waiter);
          resolve(message);
        },
      };
      // 백그라운드(지오펜스 자동 인증)에서도 쓰므로 JS 타이머 대신 네이티브 타이머를 쓴다
      const timer = setBgTimeout(() => {
        waiters.delete(waiter);
        resolve(null);
      }, timeoutMs);
      waiters.add(waiter);
    });

  return { waitFor, close: () => subscription.remove() };
};

const sendCommand = (connected: Device, ioTDevice: IoTDevice, command: string) =>
  connected.writeCharacteristicWithoutResponseForService(
    ioTDevice.ble_uuids.ble_service_uuid,
    ioTDevice.ble_uuids.ble_write_uuid,
    Buffer.from(command, "utf-8").toString("base64"),
  );

export type ServoSession = {
  range: { low: number; high: number };
  move: (deg: number) => void;
  // 성공하면 null, 실패하면 사유
  save: (low: number, high: number) => Promise<string | null>;
  close: () => Promise<void>;
};

export type ServoSessionResult =
  | { type: "ready"; session: ServoSession }
  | { type: "need_bond" | "failed"; message: string };

const NEED_BOND_MESSAGE = "이 휴대폰이 기기에 연결되어 있지 않습니다.";
const NOT_FOUND_MESSAGE = "기기를 찾지 못했습니다. 기기 전원을 확인하고 문 앞에서 다시 시도하세요.";
const CONNECT_FAILED_MESSAGE = "기기에 연결하지 못했습니다. 문 앞에서 다시 시도하세요.";

// 서보 실시간 조절 세션을 연다. 스캔 → 연결 → nonce → 본딩으로 암호화(팝업 없음) → 서버 허가 → 현재 범위 조회.
// 연결을 유지하므로 각도 명령은 서버를 거치지 않고 바로 간다. 형식은 esp32/main/ble_server.c 참고.
// onClosed: 기기 쪽 사유로 연결이 끊겼을 때만 불린다(close()는 부르지 않는다).
export const openServoSession = async (
  ioTDevice: IoTDevice,
  onClosed: () => void,
): Promise<ServoSessionResult> => {
  if (!(await hasBond(ioTDevice.device_uuid))) return { type: "need_bond", message: NEED_BOND_MESSAGE };

  const [found] = await scanDevice(ioTDevice, undefined, { timeoutMs: SERVO_SCAN_TIMEOUT_MS });
  if (!found) return { type: "failed", message: NOT_FOUND_MESSAGE };
  // 본딩 없는 주소에 암호화를 요청하면 페어링 창이 뜨고 멈춘다. 쓸 수 없는 본딩은 지워 설정 화면 표시도 맞춘다.
  if (!(await hasBond(ioTDevice.device_uuid, found.id))) {
    await unbondDevice(ioTDevice.device_uuid);
    return { type: "need_bond", message: NEED_BOND_MESSAGE };
  }
  const connected = await connectDevice(found, 0, undefined, SESSION_CONNECT_OPTIONS);
  if (!connected) return { type: "failed", message: CONNECT_FAILED_MESSAGE };

  const inbox = openInbox(connected, ioTDevice);
  let session: ServoSession | null = null;
  try {
    let nonce = await inbox.waitFor(NONCE_PATTERN, NONCE_TIMEOUT_MS);
    if (!nonce) return { type: "failed", message: CONNECT_FAILED_MESSAGE };

    // 읽기 응답이 오면 저장된 본딩으로 암호화가 끝난 것이다. 실패하면 기기 쪽에 키가 없는 경우로 보고 본딩을 지운다.
    // 일시적인 끊김이어도 재연결 한 번으로 복구되고, 문 열기는 본딩 없이도 동작한다.
    try {
      await connected.readCharacteristicForService(ioTDevice.ble_uuids.ble_service_uuid, SERVO_LIVE_CHR_UUID);
    } catch (e) {
      logDebug({ event_name, log_type: "WARNING", message: `서보 세션 암호화 실패: ${e}` });
      await unbondDevice(ioTDevice.device_uuid);
      return { type: "need_bond", message: NEED_BOND_MESSAGE };
    }

    const grant = await requestBleGrant(ioTDevice.device_uuid, "live", nonce);
    if (grant.type !== "success") return { type: "failed", message: grant.message };
    await sendCommand(connected, ioTDevice, grant.command);
    if ((await inbox.waitFor(/^(SRVS_OK|SRV_FAIL)$/)) !== "SRVS_OK") {
      return { type: "failed", message: "기기가 허가를 거부했습니다. 다시 시도하세요." };
    }

    nonce = await inbox.waitFor(NONCE_PATTERN);
    await sendCommand(connected, ioTDevice, "SRV?");
    const rangeReply = (await inbox.waitFor(/^SRV:\d+:\d+$/))?.split(":");
    if (!nonce || !rangeReply) return { type: "failed", message: CONNECT_FAILED_MESSAGE };

    connected.requestConnectionPriority(ConnectionPriority.High).catch(() => {});

    // 쓰기 하나가 끝날 때마다 최신 각도만 보낸다. 타이머가 없어 BLE가 받아주는 만큼 바로 따라간다.
    let pendingDeg: number | null = null;
    let sending = false;
    const flushMove = async () => {
      if (sending) return;
      sending = true;
      while (pendingDeg != null) {
        const deg = pendingDeg;
        pendingDeg = null;
        await connected
          .writeCharacteristicWithoutResponseForService(
            ioTDevice.ble_uuids.ble_service_uuid,
            SERVO_LIVE_CHR_UUID,
            Buffer.from([deg]).toString("base64"),
          )
          .catch(() => {});
      }
      sending = false;
    };

    const disconnected = connected.onDisconnected(() => {
      inbox.close();
      disconnected.remove();
      onClosed();
    });

    session = {
      range: { low: Number(rangeReply[1]), high: Number(rangeReply[2]) },
      move: (deg) => {
        pendingDeg = deg;
        void flushMove();
      },
      save: async (low, high) => {
        if (!nonce) return CONNECT_FAILED_MESSAGE;
        const signed = await signServoCommand(ioTDevice.device_uuid, low, high, nonce);
        if (signed.type !== "success") return signed.message;
        try {
          await sendCommand(connected, ioTDevice, signed.command);
        } catch {
          return CONNECT_FAILED_MESSAGE;
        }
        const reply = await inbox.waitFor(/^SRV_(OK|FAIL)$/);
        nonce = await inbox.waitFor(NONCE_PATTERN); // 다음 저장에 쓸 nonce를 기기가 새로 발급한다
        return reply === "SRV_OK" ? null : "기기가 명령을 거부했습니다. 다시 시도하세요.";
      },
      close: async () => {
        disconnected.remove();
        inbox.close();
        await connected.cancelConnection().catch(() => {});
      },
    };
    return { type: "ready", session };
  } catch (e) {
    logDebug({ event_name, log_type: "WARNING", message: `서보 세션 실패: ${e}` });
    return { type: "failed", message: CONNECT_FAILED_MESSAGE };
  } finally {
    if (!session) {
      inbox.close();
      await connected.cancelConnection().catch(() => {});
    }
  }
};

// 이 휴대폰으로 다시 본딩한다(휴대폰 교체·본딩 유실). 서버가 master를 확인해 기기가 이 연결에서만 페어링을 받는다.
// 셋업과 같은 순서: 옛 본딩 제거 → 연결 → 페어링 시작은 앱이 → 결과에 따라 본딩 기록 또는 제거.
export const rebondDevice = async (ioTDevice: IoTDevice): Promise<string | null> => {
  const [found] = await scanDevice(ioTDevice, undefined, { timeoutMs: SERVO_SCAN_TIMEOUT_MS });
  if (!found) return NOT_FOUND_MESSAGE;

  await resetBond(found.id);
  const connected = await connectDevice(found, 0, undefined, SESSION_CONNECT_OPTIONS);
  if (!connected) return CONNECT_FAILED_MESSAGE;

  const inbox = openInbox(connected, ioTDevice);
  try {
    const nonce = await inbox.waitFor(NONCE_PATTERN, NONCE_TIMEOUT_MS);
    if (!nonce) return CONNECT_FAILED_MESSAGE;

    const grant = await requestBleGrant(ioTDevice.device_uuid, "bond", nonce);
    if (grant.type !== "success") return grant.message;
    await sendCommand(connected, ioTDevice, grant.command);
    if ((await inbox.waitFor(/^(SRVB_OK|SRV_FAIL)$/)) !== "SRVB_OK") {
      return "기기가 허가를 거부했습니다. 다시 시도하세요.";
    }

    await markPendingBond(found.id);
    await triggerPairing(connected, {
      ...ioTDevice,
      ble_uuids: { ...ioTDevice.ble_uuids, ble_read_uuid: SERVO_LIVE_CHR_UUID },
    });
    if ((await inbox.waitFor(/^BOND_(OK|FAIL)$/, BOND_RESULT_TIMEOUT_MS)) !== "BOND_OK") {
      await dropPendingBond();
      return "페어링을 완료하지 못했습니다. 다시 시도하세요.";
    }
    await commitBond(ioTDevice.device_uuid);
    return null;
  } catch (e) {
    logDebug({ event_name, log_type: "WARNING", message: `재본딩 실패: ${e}` });
    await dropPendingBond();
    return CONNECT_FAILED_MESSAGE;
  } finally {
    inbox.close();
    await connected.cancelConnection().catch(() => {});
  }
};
