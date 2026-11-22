// 앱 전역 백그라운드 등록. 진입점(index.ts)이 라우트보다 먼저 import한다.
// expo-router는 라우트 모듈(app/_layout.tsx 등)을 화면을 그릴 때만 로드하므로, 앱 프로세스가 죽은 상태에서
// 지오펜스·푸시·알림 버튼으로 headless 기동되면 라우트 안의 등록은 실행되지 않는다. 그래서 여기 모은다.
import { fetchDevices } from "@/lib/api/devices";
import { setupAxiosInterceptors } from "@/lib/api/interceptors";
import { authLog, short } from "@/lib/auth-log";
import { updateGeoFence } from "@/lib/background-tracking";
import { DEVICES_REFRESHED_EVENT } from "@/lib/constants";
import { appendFcmNotification } from "@/lib/fcm-log";
import { createFeedbackFromPush, setPendingFeedbackNav, submitFeedback } from "@/lib/proximity";
import type { FeedbackAnswer } from "@/lib/proximity-rules";
import "@/tasks/bg-location"; // TaskManager.defineTask(지오펜스)
import { getApp } from "@react-native-firebase/app";
import { getMessaging, setBackgroundMessageHandler, type FirebaseMessagingTypes } from "@react-native-firebase/messaging";
import notifee, { AndroidImportance, EventType, type Event } from "@notifee/react-native";
import { DeviceEventEmitter, Platform } from "react-native";

setupAxiosInterceptors();

// 서버가 data.type="refresh_devices"를 실어 보내는 푸시(게스트 토큰 발급·삭제, 추방).
// 앱을 열지 않아도 토큰 캐시와 지오펜스 등록을 최신으로 맞춘다.
const refreshDevicesFromPush = async (data?: { [key: string]: unknown }) => {
  if (data?.type !== "refresh_devices") return;
  try {
    await fetchDevices();
    await updateGeoFence();
    // 열려 있는 상세 화면이 30초 주기를 기다리지 않고 바로 다시 그리도록 알린다
    DeviceEventEmitter.emit(DEVICES_REFRESHED_EVENT);
  } catch {
    // 다음 앱 실행 시 홈 화면에서 다시 동기화된다
  }
};

// 해제 타이밍 피드백 버튼 (Android 최대 3개)
const FEEDBACK_ACTIONS: { id: string; title: string; answer: FeedbackAnswer }[] = [
  { id: "fb_early", title: "일찍", answer: "early" },
  { id: "fb_ok", title: "적당", answer: "ok" },
  { id: "fb_late", title: "늦게", answer: "late" },
];
const FEEDBACK_CATEGORY = "unlock_feedback";
// iOS는 버튼을 카테고리로 미리 등록해야 한다(Android는 알림마다 actions로 지정)
if (Platform.OS === "ios") {
  notifee
    .setNotificationCategories([
      { id: FEEDBACK_CATEGORY, actions: FEEDBACK_ACTIONS.map((a) => ({ id: a.id, title: a.title })) },
    ])
    .catch(() => {});
}

// 서버의 인증 결과 푸시를 자동 인증 로그에 남긴다(앱이 서버 결과를 알 수 있는 유일한 경로)
const logAuthResultPush = (remoteMessage: FirebaseMessagingTypes.RemoteMessage) => {
  const data = remoteMessage.data;
  if (data?.event !== "unlock_success" && data?.event !== "unlock_denied") return;
  const dev = typeof data.device_uuid === "string" ? short(data.device_uuid) : "?";
  const delay = remoteMessage.sentTime ? ` · 서버 발송 후 ${Date.now() - remoteMessage.sentTime}ms 뒤 수신` : "";
  authLog(
    "PUSH",
    data.event === "unlock_success"
      ? `${dev} 서버 인증 성공${delay}`
      : `${dev} 서버 인증 거부: ${data.reason ?? "?"}${delay}`,
  );
};

// 포그라운드·백그라운드 공통 푸시 처리. 내 자동 해제의 성공 푸시면 피드백 버튼을 단다.
export const handlePush = async (remoteMessage: FirebaseMessagingTypes.RemoteMessage) => {
  logAuthResultPush(remoteMessage);
  // 서버는 제목·본문을 data로 보낸다(fcm_utils.py, 시스템이 따로 띄워 알림이 두 번 뜨지 않게). 옛 서버의 notification도 읽는다
  const title = remoteMessage.notification?.title ?? (remoteMessage.data?.title as string | undefined);
  const rawBody = remoteMessage.notification?.body ?? (remoteMessage.data?.body as string | undefined);
  const feedbackId = await createFeedbackFromPush(remoteMessage.data);
  const body = feedbackId ? `${rawBody ?? ""} · 열리는 타이밍은 어땠나요?` : rawBody;
  await appendFcmNotification(title, body, feedbackId ?? undefined);
  await refreshDevicesFromPush(remoteMessage.data);
  const channelId = await notifee.createChannel({
    id: "default",
    name: "기본 알림",
    importance: AndroidImportance.HIGH,
  });
  await notifee.displayNotification({
    title,
    body,
    data: feedbackId ? { ...remoteMessage.data, feedback_id: feedbackId } : remoteMessage.data,
    android: {
      channelId,
      pressAction: { id: "default" },
      // notifee는 기본으로 시간을 숨긴다. Doze로 늦게 받아도 서버가 보낸 시각이 보이게 sentTime을 쓴다.
      timestamp: remoteMessage.sentTime || Date.now(),
      showTimestamp: true,
      actions: feedbackId ? FEEDBACK_ACTIONS.map((a) => ({ title: a.title, pressAction: { id: a.id } })) : undefined,
    },
    ios: feedbackId ? { categoryId: FEEDBACK_CATEGORY } : undefined,
  });
};

// 알림 버튼(일찍/적당/늦게) → 앱을 띄우지 않고 반영. 본문 탭 → 피드백 화면으로 보낸다.
export const handleNotifeeEvent = async ({ type, detail }: Event) => {
  const feedbackId = detail.notification?.data?.feedback_id;
  if (typeof feedbackId !== "string") return;
  if (type === EventType.ACTION_PRESS) {
    const answer = FEEDBACK_ACTIONS.find((a) => a.id === detail.pressAction?.id)?.answer;
    if (!answer) return;
    await submitFeedback(feedbackId, answer, "notification");
    if (detail.notification?.id) await notifee.cancelNotification(detail.notification.id);
  } else if (type === EventType.PRESS) {
    await setPendingFeedbackNav(feedbackId);
  }
};
notifee.onBackgroundEvent(handleNotifeeEvent);

// 앱이 종료/백그라운드 상태일 때 수신
setBackgroundMessageHandler(getMessaging(getApp()), handlePush);
