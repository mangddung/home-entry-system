import { requestBluetoothPermission } from "@/hooks/request-ble-permit";
import { requestLocationPermissions } from "@/hooks/request-location-permit";
import { verifyToken } from "@/lib/api/auth";
import { updateGeoFence } from "@/lib/background-tracking";
// import { setupBgLocation, startBgLocationTask } from "@/lib/background-tracking"; // GPS 폴링 방식 (geofence로 대체)
import { IS_ONLINE_KEY } from "@/lib/constants";
import { appendSystemLog } from "@/lib/system-log";
import { checkAuthToken, setTokenSecure } from "@/lib/token-storage";
import { startActivityTransitionLog } from "@/modules/activity-transition";
import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, AppState, Linking, PermissionsAndroid, Platform, Text, View } from "react-native";
import {
  BatteryOptEnabled,
  RequestDisableOptimization,
} from "react-native-battery-optimization-check";

export default function IndexScreen() {
  const [isReady, setIsReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const checkPermissions = async (): Promise<{
    ble: boolean;
    gps: boolean;
    battery: boolean;
    notification: boolean;
  }> => {
    const ble = await requestBluetoothPermission();
    const gps = await requestLocationPermissions();
    const battery = Platform.OS === "android" ? !(await BatteryOptEnabled()) : true;
    if (Platform.OS === "android" && !battery) {
      RequestDisableOptimization();
    }
    let notification = true;
    if (Platform.OS === "android" && parseInt(Platform.Version.toString(), 10) >= 33) {
      const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
      notification = result === PermissionsAndroid.RESULTS.GRANTED;
    }
    return { ble, gps, battery, notification };
  };

  const showPermissionBlocker = (ble: boolean, gps: boolean, battery: boolean, notification: boolean) => {
    const missing = [
      !ble && "근처 기기",
      !gps && "위치(항상 허용)",
      !battery && "배터리(제한 없음)",
      !notification && "알림",
    ]
      .filter(Boolean)
      .join(", ");
    Alert.alert(
      "권한 필요",
      `다음 권한을 허용해주세요\n${missing}`,
      [
        { text: "설정 열기", onPress: () => Linking.openSettings() },
        {
          text: "재확인",
          onPress: async () => {
            const { ble: b, gps: g, battery: bat, notification: n } = await checkPermissions();
            if (b && g && bat && n) {
              setPermissionDenied(false);
              await checkAndSetAuth();
              // await setupBgLocation();
              // await startBgLocationTask();
              await updateGeoFence();
            } else {
              showPermissionBlocker(b, g, bat, n);
            }
          },
        },
      ],
      { cancelable: false },
    );
    setPermissionDenied(true);
  };

  const checkAndSetAuth = async () => {
    const isInitialized = await checkAuthToken();
    if (isInitialized) {
      const result = await verifyToken();
      if (result.type === "success") {
        await setTokenSecure(IS_ONLINE_KEY, "true");
        appendSystemLog({ event_name: "entry", log_type: "INFO", message: "online 모드 진입" });
        setIsAuthenticated(true);
      } else if (result.type === "no_response" || isInitialized) {
        await setTokenSecure(IS_ONLINE_KEY, "false");
        appendSystemLog({ event_name: "entry", log_type: "INFO", message: "offline 모드 진입" });
        setIsAuthenticated(true);
      } else {
        await setTokenSecure(IS_ONLINE_KEY, "true");
        setIsAuthenticated(false);
      }
    } else {
      await setTokenSecure(IS_ONLINE_KEY, "true");
      setIsAuthenticated(false);
    }
    setIsReady(true);
  };

  useEffect(() => {
    void (async () => {
      const { ble, gps, battery, notification } = await checkPermissions();
      if (!ble || !gps || !battery || !notification) {
        showPermissionBlocker(ble, gps, battery, notification);
        return;
      }
      await checkAndSetAuth();

      // BG 태스크 시작
      // await setupBgLocation();
      // await startBgLocationTask();
      await updateGeoFence();
      // 활동 전환 감지 등록 (N3 릴레이 완화: 오래 정지 중이면 자동 해제 거부). 재부팅 시 등록이 풀려 실행마다 호출
      await startActivityTransitionLog();
    })();
  }, []);

  // 설정에서 돌아왔을 때 권한 재확인
  useEffect(() => {
    if (!permissionDenied) return;
    const sub = AppState.addEventListener("change", async (state) => {
      if (state === "active") {
        const { ble, gps, battery, notification } = await checkPermissions();
        if (ble && gps && battery && notification) {
          setPermissionDenied(false);
          // 권한 받은 이후 로직 시작
          await checkAndSetAuth();
        } else {
          showPermissionBlocker(ble, gps, battery, notification);
        }
      }
    });
    return () => sub.remove();
  }, [permissionDenied]);

  if (permissionDenied) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <Text>권한을 허용해야 앱을 사용할 수 있습니다.</Text>
      </View>
    );
  }

  if (!isReady) {
    return (
      <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (isAuthenticated) {
    return <Redirect href="/(tabs)/home" />;
  }

  return <Redirect href="/login-oauth" />;
}
