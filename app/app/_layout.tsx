import { type AlertButton, CustomAlert } from "@/components/custom-alert";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { registerAlertHost } from "@/lib/alert";
import { handleNotifeeEvent, handlePush } from "@/lib/app-handlers";
import { applyThemePref, getThemePref } from "@/lib/theme-pref";
import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { getApp } from "@react-native-firebase/app";
import { getMessaging, onMessage } from "@react-native-firebase/messaging";
import notifee, { EventType } from "@notifee/react-native";
import { consumePendingFeedbackNav } from "@/lib/proximity";
import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import "react-native-reanimated";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

// 백그라운드 태스크·푸시·알림 핸들러 등록은 진입점(index.ts → lib/app-handlers.ts)에서 한다.

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

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
          <Stack.Screen name="device/servo-range" options={{ headerShown: false }} />
          <Stack.Screen name="ble-debug" options={{ headerShown: false }} />
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
