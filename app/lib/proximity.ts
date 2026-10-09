// 근접 해제(계획서 4.11) 로컬 저장소: 기기별 내 보정값, 자동 트리거 기록, 해제 타이밍 피드백.
// 비밀값이 아니라 AsyncStorage에 둔다(SecureStore 키당 2KB 제한 회피). 규칙은 proximity-rules.ts.

import notifee from "@notifee/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEVICE_STATUS_KEY } from "./constants";
import {
  applyAnswer,
  type Calibration,
  effectiveThreshold,
  FEEDBACK_MATCH_MS,
  type FeedbackAnswer,
  type FeedbackRecord,
  feedbackStatus,
  IMPLICIT_LATE_MS,
} from "./proximity-rules";
import { getTokenSecure } from "./token-storage";
import type { DeviceStatus, IoTDevice } from "./types";

const CALIBRATION_KEY = "rssi-calibration"; // { [device_uuid]: Calibration }
const TRIGGER_KEY = "rssi-last-trigger"; // { [device_uuid]: { rssi, threshold, at } }
const FEEDBACK_KEY = "unlock-feedback"; // FeedbackRecord[] (최신순)
const FEEDBACK_ENABLED_KEY = "unlock-feedback-enabled"; // "0"이면 꺼짐, 기본 켜짐
const FEEDBACK_MAX = 50;

type Trigger = { rssi: number; threshold: number; at: number };

const readJson = async <T>(key: string, fallback: T): Promise<T> => {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, value: unknown) => AsyncStorage.setItem(key, JSON.stringify(value));

// ── 보정값 ──────────────────────────────────────────────────────────────────

export const loadCalibrations = () => readJson<Record<string, Calibration>>(CALIBRATION_KEY, {});

export const getThresholdFor = async (device: IoTDevice) =>
  effectiveThreshold((await loadCalibrations())[device.device_uuid], device.rssi_threshold);

// 기준점 측정값으로 내 보정을 새로 시작한다(피드백 누적은 초기화)
export const setReferenceRssi = async (device_uuid: string, ref_rssi: number) => {
  const all = await loadCalibrations();
  all[device_uuid] = { ref_rssi, adjust_db: 0, streak: 0 };
  await writeJson(CALIBRATION_KEY, all);
};

export const resetCalibration = async (device_uuid: string) => {
  const all = await loadCalibrations();
  delete all[device_uuid];
  await writeJson(CALIBRATION_KEY, all);
};

// 기기 목록에서 빠진 기기의 보정값 삭제. fetchDevices()가 목록이 바뀐 경우에만 부른다.
export const pruneCalibrations = async (validUuids: string[]) => {
  const all = await loadCalibrations();
  const valid = new Set(validUuids);
  const stale = Object.keys(all).filter((uuid) => !valid.has(uuid));
  if (stale.length === 0) return;
  for (const uuid of stale) delete all[uuid];
  await writeJson(CALIBRATION_KEY, all);
};

// ── 피드백 ──────────────────────────────────────────────────────────────────

export const isFeedbackEnabled = async () => (await AsyncStorage.getItem(FEEDBACK_ENABLED_KEY)) !== "0";
export const setFeedbackEnabled = (on: boolean) => AsyncStorage.setItem(FEEDBACK_ENABLED_KEY, on ? "1" : "0");

// 자동 트리거 순간 기록. 성공 푸시가 오면 짝지어 피드백 알림을 만든다.
export const recordTrigger = async (device_uuid: string, rssi: number, threshold: number) => {
  const all = await readJson<Record<string, Trigger>>(TRIGGER_KEY, {});
  all[device_uuid] = { rssi, threshold, at: Date.now() };
  await writeJson(TRIGGER_KEY, all);
};

export const loadFeedback = () => readJson<FeedbackRecord[]>(FEEDBACK_KEY, []);

const saveFeedback = async (rec: FeedbackRecord) => {
  const list = (await loadFeedback()).filter((r) => r.id !== rec.id);
  await writeJson(FEEDBACK_KEY, [rec, ...list].slice(0, FEEDBACK_MAX));
};

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// "인증 성공" 푸시(data.event=unlock_success)가 내 자동 트리거와 짝이 맞으면 피드백 레코드를 만들고 id를 돌려준다.
// 수동 인증이었거나 피드백이 꺼져 있으면 null → 일반 알림.
export const createFeedbackFromPush = async (data?: { [key: string]: unknown }): Promise<string | null> => {
  if (data?.event !== "unlock_success" || typeof data.device_uuid !== "string") return null;
  const device_uuid = data.device_uuid;
  const triggers = await readJson<Record<string, Trigger>>(TRIGGER_KEY, {});
  const trig = triggers[device_uuid];
  if (!trig) return null;
  delete triggers[device_uuid]; // 한 트리거는 한 번만 짝짓는다
  await writeJson(TRIGGER_KEY, triggers);
  if (Date.now() - trig.at > FEEDBACK_MATCH_MS || !(await isFeedbackEnabled())) return null;

  const rec: FeedbackRecord = {
    id: newId(),
    device_uuid,
    trigger_rssi: trig.rssi,
    threshold: trig.threshold,
    at: trig.at,
    status: "pending",
  };
  await saveFeedback(rec);
  return rec.id;
};

const applyToCalibration = async (rec: FeedbackRecord, answer: FeedbackAnswer) => {
  const all = await loadCalibrations();
  // 보정 안 한 기기면 그때 쓰던 문턱(기기 임계값)을 내 기준으로 삼아 시작한다
  const base = all[rec.device_uuid] ?? { ref_rssi: rec.threshold, adjust_db: 0, streak: 0 };
  all[rec.device_uuid] = applyAnswer(base, answer);
  await writeJson(CALIBRATION_KEY, all);
};

// id 기준 멱등: pending(미만료)일 때만 반영하고 done으로 바꾼다. 반영했으면 true.
export const submitFeedback = async (id: string, answer: FeedbackAnswer, source: "notification" | "app") => {
  const rec = (await loadFeedback()).find((r) => r.id === id);
  if (!rec || feedbackStatus(rec) !== "pending") return false;
  await saveFeedback({ ...rec, status: "done", answer, source });
  await applyToCalibration(rec, answer);
  return true;
};

// 진입 직후(자동 해제 진행 중) 사용자가 수동 인증을 누르면 "늦음"으로 반영한다.
export const noteManualUnlock = async (device: IoTDevice) => {
  if (device.role === "guest" || !(await isFeedbackEnabled())) return;
  const threshold = await getThresholdFor(device);
  if (threshold == null) return; // RSSI 트리거를 안 쓰는 기기(첫 발견 즉시 연결)
  const raw = await getTokenSecure(DEVICE_STATUS_KEY);
  const status = (raw ? (JSON.parse(raw) as DeviceStatus[]) : []).find((s) => s.device_uuid === device.device_uuid);
  if (!status?.isInside || status.bleSuccess || !status.enteredAt) return;
  if (Date.now() - status.enteredAt > IMPLICIT_LATE_MS) return;

  const rec: FeedbackRecord = {
    id: newId(),
    device_uuid: device.device_uuid,
    trigger_rssi: null,
    threshold,
    at: Date.now(),
    status: "done",
    answer: "late",
    source: "implicit",
  };
  await saveFeedback(rec);
  await applyToCalibration(rec, "late");
};

// ── 피드백 화면 이동 예약 ──────────────────────────────────────────────────
// 알림 본문을 백그라운드에서 누르면 이벤트 시점엔 화면이 없을 수 있어 id를 남겨두고, 앱이 활성화되면 꺼내 쓴다.
const PENDING_NAV_KEY = "unlock-feedback-nav";
let initialChecked = false;

export const setPendingFeedbackNav = (id: string) => AsyncStorage.setItem(PENDING_NAV_KEY, id);

// 이동할 피드백 id(없으면 null). 앱이 종료 상태에서 알림으로 켜진 경우는 JS 세션당 한 번 확인한다.
export const consumePendingFeedbackNav = async (): Promise<string | null> => {
  const pending = await AsyncStorage.getItem(PENDING_NAV_KEY);
  if (pending) await AsyncStorage.removeItem(PENDING_NAV_KEY);
  if (!initialChecked) {
    initialChecked = true;
    const initialId = (await notifee.getInitialNotification())?.notification.data?.feedback_id;
    if (typeof initialId === "string") return initialId;
  }
  return pending;
};
