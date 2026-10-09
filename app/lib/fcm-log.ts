import AsyncStorage from "@react-native-async-storage/async-storage";
import { FCM_NOTIFICATIONS_KEY, FCM_NOTIFICATIONS_LAST_READ_AT_KEY } from "./constants";

export type FcmNotificationItem = {
  title?: string;
  body?: string;
  timestamp: string;
  feedback_id?: string; // 해제 타이밍 피드백 대상 알림 (lib/proximity.ts)
};

export const appendFcmNotification = async (title?: string, body?: string, feedback_id?: string) => {
  const raw = await AsyncStorage.getItem(FCM_NOTIFICATIONS_KEY);
  const list: FcmNotificationItem[] = raw ? JSON.parse(raw) : [];
  list.unshift({ title, body, timestamp: new Date().toISOString(), feedback_id });
  await AsyncStorage.setItem(FCM_NOTIFICATIONS_KEY, JSON.stringify(list.slice(0, 50)));
};

export const loadFcmNotifications = async (): Promise<FcmNotificationItem[]> => {
  const raw = await AsyncStorage.getItem(FCM_NOTIFICATIONS_KEY);
  return raw ? JSON.parse(raw) : [];
};

export const getFcmLastReadAt = async (): Promise<Date> => {
  const raw = await AsyncStorage.getItem(FCM_NOTIFICATIONS_LAST_READ_AT_KEY);
  return raw ? new Date(raw) : new Date(0);
};

export const setFcmLastReadAt = async () => {
  await AsyncStorage.setItem(FCM_NOTIFICATIONS_LAST_READ_AT_KEY, new Date().toISOString());
};
