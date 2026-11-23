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
// esp32/main/app_config.h의 BLE_DEVICE_NAME_PREFIX. "DoorLock"은 구버전 펌웨어 잔재 정리용.
const DEVICE_NAME_PREFIX = "doorl-";
const LEGACY_DEVICE_NAME = "DoorLock";
const isOurDevice = (name: string | null) =>
  !!name && (name.startsWith(DEVICE_NAME_PREFIX) || name === LEGACY_DEVICE_NAME);

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
  // removeBond()는 해제를 요청만 하고 바로 돌아온다. 끝나기 전에 연결하면 폰이 옛 키로 암호화를 시도해
  // 연결이 끊기거나, 재본딩에서 새 페어링 없이 옛 키로 암호화돼 기기가 BOND_OK를 보내지 않는다.
  for (let i = 0; i < 10; i++) {
    const bonded = await BleBond!.bondedDevices().catch(() => []);
    if (!bonded.some((b) => b.address === mac)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
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

/** 이 휴대폰에 기기 본딩이 있는지. 폰 기록만 보므로 기기 쪽 상태는 연결해 봐야 안다.
 *  address: 스캔으로 확인한 기기의 현재 주소. 주소가 다르면 그 본딩은 쓸 수 없다. */
export const hasBond = async (device_uuid: string, address?: string) => {
  if (!supported) return false;
  const mac = (await readMap())[device_uuid];
  if (!mac || (address && address !== mac)) return false;
  const bonded = await BleBond!.bondedDevices().catch(() => []);
  return bonded.some((b) => b.address === mac);
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

  // 매핑이 없는 잔재 본딩(구버전/재설정 흔적)까지 정리. 우리 기기 이름만 건드린다.
  const keep = new Set(Object.values(map));
  const pending = await AsyncStorage.getItem(PENDING_KEY);
  if (pending) keep.add(pending);
  const bonded = await BleBond!.bondedDevices().catch(() => []);
  for (const b of bonded) {
    if (isOurDevice(b.name) && !keep.has(b.address)) await remove(b.address);
  }
};
