import AsyncStorage from "@react-native-async-storage/async-storage";
import { NativeModules, Platform } from "react-native";
import { loadDevices } from "./api/devices";

type BleBondNative = {
  removeBond(address: string): Promise<boolean>;
  bondedDevices(): Promise<{ address: string; name: string | null }[]>;
};

const BleBond: BleBondNative | undefined = (NativeModules as any).BleBond;
const supported = Platform.OS === "android" && !!BleBond;

const MAP_KEY = "ble_bond_map"; // { [device_uuid]: mac }
const PENDING_KEY = "ble_bond_pending"; // 셋업 진행 중인 mac
const DEVICE_NAME = "DoorLock"; // esp32/main/app_config.h의 BLE_DEVICE_NAME

const readMap = async (): Promise<Record<string, string>> => {
  const raw = await AsyncStorage.getItem(MAP_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const writeMap = (map: Record<string, string>) =>
  AsyncStorage.setItem(MAP_KEY, JSON.stringify(map));

const remove = (mac: string) => BleBond!.removeBond(mac).catch(() => false);

/** 셋업 직전 호출 – 남아 있는 본딩을 지워 항상 새 페어링으로 시작한다.
 *  (기기를 재부팅/팩토리리셋하면 ESP32 쪽 키가 사라지는데 Android는 옛 키를
 *   그대로 써서 암호화가 실패한다. 연결 전에 끊어줘야 한다.) */
export const resetBond = async (mac: string) => {
  if (!supported) return;
  await remove(mac);
};

/** 셋업 중 연결한 기기의 mac 기록 (등록 완료 전 중단되면 본딩 제거 대상) */
export const markPendingBond = async (mac: string) => {
  if (!supported) return;
  await AsyncStorage.setItem(PENDING_KEY, mac);
};

/** 등록 완료 – 본딩을 device_uuid에 귀속시켜 유지 */
export const commitBond = async (device_uuid: string) => {
  if (!supported) return;
  const mac = await AsyncStorage.getItem(PENDING_KEY);
  await AsyncStorage.removeItem(PENDING_KEY);
  if (!mac) return;
  const map = await readMap();
  map[device_uuid] = mac;
  await writeMap(map);
};

/** 셋업 실패/취소 – 방금 생긴 본딩 제거 */
export const dropPendingBond = async () => {
  if (!supported) return;
  const mac = await AsyncStorage.getItem(PENDING_KEY);
  if (!mac) return;
  await AsyncStorage.removeItem(PENDING_KEY);
  await remove(mac);
};

/** 기기 삭제 시 본딩도 제거 */
export const unbondDevice = async (device_uuid: string) => {
  if (!supported) return;
  const map = await readMap();
  const mac = map[device_uuid];
  if (!mac) return;
  delete map[device_uuid];
  await writeMap(map);
  await remove(mac);
};

/** 앱 기기 목록에 없는 DoorLock 본딩 일괄 제거 */
export const sweepOrphanBonds = async () => {
  if (!supported) return;
  const map = await readMap();
  const uuids = new Set((await loadDevices()).map((d) => d.device_uuid));

  for (const [uuid, mac] of Object.entries(map)) {
    if (uuids.has(uuid)) continue;
    delete map[uuid];
    await remove(mac);
  }
  await writeMap(map);

  // 매핑이 없는 잔재 본딩(구버전/재설정 흔적)까지 정리. DoorLock 이름만 건드린다.
  const keep = new Set(Object.values(map));
  const pending = await AsyncStorage.getItem(PENDING_KEY);
  if (pending) keep.add(pending);
  const bonded = await BleBond!.bondedDevices().catch(() => []);
  for (const b of bonded) {
    if (b.name === DEVICE_NAME && !keep.has(b.address)) await remove(b.address);
  }
};
