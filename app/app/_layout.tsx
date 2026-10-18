import { type AlertButton, CustomAlert } from "@/components/custom-alert";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { fetchDevices } from "@/lib/api/devices";
import { setupAxiosInterceptors } from "@/lib/api/interceptors";
import { updateGeoFence } from "@/lib/background-tracking";
import { appendFcmNotification } from "@/lib/fcm-log";
import { DEVICES_REFRESHED_EVENT } from "@/lib/constants";
import { registerAlertHost } from "@/lib/alert";
import { applyThemePref, getThemePref } from "@/lib/theme-pref";
import "@/tasks/bg-location";
import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { getApp } from "@react-native-firebase/app";
import { getMessaging, onMessage, setBackgroundMessageHandler, type FirebaseMessagingTypes } from "@react-native-firebase/messaging";
import notifee, { AndroidImportance, EventType, type Event } from "@notifee/react-native";
import { consumePendingFeedbackNav, createFeedbackFromPush, setPendingFeedbackNav, submitFeedback } from "@/lib/proximity";
import type { FeedbackAnswer } from "@/lib/proximity-rules";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import "react-native-get-random-values";
import "react-native-reanimated";
import { AppState, DeviceEventEmitter, Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

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

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

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

// 포그라운드·백그라운드 공통 푸시 처리. 내 자동 해제의 성공 푸시면 피드백 버튼을 단다.
const handlePush = async (remoteMessage: FirebaseMessagingTypes.RemoteMessage) => {
  const feedbackId = await createFeedbackFromPush(remoteMessage.data);
  const body = feedbackId
    ? `${remoteMessage.notification?.body ?? ""} · 열리는 타이밍은 어땠나요?`
    : remoteMessage.notification?.body;
  await appendFcmNotification(remoteMessage.notification?.title, body, feedbackId ?? undefined);
  await refreshDevicesFromPush(remoteMessage.data);
  const channelId = await notifee.createChannel({
    id: "default",
    name: "기본 알림",
    importance: AndroidImportance.HIGH,
  });
  await notifee.displayNotification({
    title: remoteMessage.notification?.title,
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
const handleNotifeeEvent = async ({ type, detail }: Event) => {
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

export const unstable_settings = {
  initialRouteName: "index",
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  // showAlert로 들어온 알림을 순서대로 하나씩 띄운다(겹쳐 들어와도 버튼 콜백을 잃지 않게)
  const [alerts, setAlerts] = useState<{ title: string; message?: string; buttons?: AlertButton[] }[]>([]);
  const currentAlert = alerts[0];

  useEffect(() => {
    void getThemePref().then(applyThemePref);
  }, []);

  useEffect(() => {
    registerAlertHost((title, message, buttons) => {
      setAlerts((q) => [...q, { title, message, buttons }]);
    });
  }, []);

  useEffect(() => {
    // 앱이 포그라운드 상태일 때 수신
    const unsubscribe = onMessage(getMessaging(getApp()), handlePush);
    // 포그라운드에서 누른 피드백 알림은 바로 처리하고, 본문 탭이면 피드백 화면으로 이동
    const unsubscribeNotifee = notifee.onForegroundEvent(async (event) => {
      await handleNotifeeEvent(event);
      if (event.type === EventType.PRESS) {
        const id = await consumePendingFeedbackNav();
        if (id) router.push({ pathname: "/feedback", params: { id } });
      }
    });
    // 백그라운드에서 본문을 눌러 앱으로 돌아온 경우
    const appStateSub = AppState.addEventListener("change", async (state) => {
      if (state !== "active") return;
      const id = await consumePendingFeedbackNav();
      if (id) router.push({ pathname: "/feedback", params: { id } });
    });
    return () => {
      unsubscribe();
      unsubscribeNotifee();
      appStateSub.remove();
    };
  }, []);

  return (
    <SafeAreaProvider>
      <ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
        <Stack>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="login-oauth" options={{ headerShown: false }} />
          <Stack.Screen name="device/location-setup" options={{ headerShown: false }} />
          <Stack.Screen name="device/device_setup" options={{ headerShown: false }} />
          <Stack.Screen name="device/device_debug" options={{ headerShown: false }} />
          <Stack.Screen name="device/device_info" options={{ headerShown: false }} />
          <Stack.Screen name="device/device_setting" options={{ headerShown: false }} />
          <Stack.Screen name="register_invite_code" options={{ headerShown: false }} />
          <Stack.Screen name="feedback" options={{ headerShown: false }} />
          <Stack.Screen name="device/rssi-calibrate" options={{ headerShown: false }} />
          <Stack.Screen name="modal" options={{ presentation: "modal", title: "Modal" }} />
        </Stack>

        <StatusBar style="auto" />

        <CustomAlert
          visible={!!currentAlert}
          title={currentAlert?.title ?? ""}
          message={currentAlert?.message}
          buttons={(currentAlert?.buttons?.length ? currentAlert.buttons : [{ text: "확인" }]).map((b) => ({
            ...b,
            onPress: () => {
              setAlerts((q) => q.slice(1));
              b.onPress?.();
            },
          }))}
          onRequestClose={() => {}}
        />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
