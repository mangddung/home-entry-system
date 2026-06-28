import { CustomAlert } from "@/components/custom-alert";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { setupAxiosInterceptors } from "@/lib/api/interceptors";
import { appendFcmNotification } from "@/lib/fcm-log";
import { registerSessionAlert } from "@/lib/session-alert";
import "@/tasks/bg-location";
import { DarkTheme, DefaultTheme, ThemeProvider } from "@react-navigation/native";
import { getApp } from "@react-native-firebase/app";
import { getMessaging, onMessage, setBackgroundMessageHandler } from "@react-native-firebase/messaging";
import notifee, { AndroidImportance } from "@notifee/react-native";
import * as Notifications from "expo-notifications";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import "react-native-get-random-values";
import "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";

setupAxiosInterceptors();

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// 앱이 종료/백그라운드 상태일 때 수신
setBackgroundMessageHandler(getMessaging(getApp()), async (remoteMessage) => {
  await appendFcmNotification(remoteMessage.notification?.title, remoteMessage.notification?.body);
  const channelId = await notifee.createChannel({
    id: "default",
    name: "기본 알림",
    importance: AndroidImportance.HIGH,
  });
  await notifee.displayNotification({
    title: remoteMessage.notification?.title,
    body: remoteMessage.notification?.body,
    data: remoteMessage.data,
    android: { channelId, pressAction: { id: "default" } },
  });
});

export const unstable_settings = {
  initialRouteName: "index",
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [sessionAlert, setSessionAlert] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const onConfirmRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    registerSessionAlert((title, message, onConfirm) => {
      onConfirmRef.current = onConfirm;
      setSessionAlert({ title, message, onConfirm });
    });
  }, []);

  useEffect(() => {
    // 앱이 포그라운드 상태일 때 수신
    const unsubscribe = onMessage(getMessaging(getApp()), async (remoteMessage) => {
      await appendFcmNotification(remoteMessage.notification?.title, remoteMessage.notification?.body);
      const channelId = await notifee.createChannel({
        id: "default",
        name: "기본 알림",
        importance: AndroidImportance.HIGH,
      });
      await notifee.displayNotification({
        title: remoteMessage.notification?.title,
        body: remoteMessage.notification?.body,
        data: remoteMessage.data,
        android: { channelId, pressAction: { id: "default" } },
      });
    });
    return unsubscribe;
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
          <Stack.Screen name="modal" options={{ presentation: "modal", title: "Modal" }} />
        </Stack>

        <StatusBar style="auto" />

        <CustomAlert
          visible={!!sessionAlert}
          title={sessionAlert?.title ?? ""}
          message={sessionAlert?.message}
          buttons={[{
            text: "확인",
            onPress: () => {
              setSessionAlert(null);
              onConfirmRef.current?.();
            },
          }]}
          onRequestClose={() => {}}
        />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
