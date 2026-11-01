import { checkBluetoothPermission, requestBluetoothPermission } from "@/hooks/request-ble-permit";
import { checkLocationPermissions, requestLocationPermissions } from "@/hooks/request-location-permit";
import { showAlert } from "@/lib/alert";
import { verifyToken } from "@/lib/api/auth";
import { updateGeoFence } from "@/lib/background-tracking";
// import { setupBgLocation, startBgLocationTask } from "@/lib/background-tracking"; // GPS 폴링 방식 (geofence로 대체)
import { authLog } from "@/lib/auth-log";
import { IS_ONLINE_KEY } from "@/lib/constants";
import { appendSystemLog } from "@/lib/system-log";
import { checkAuthToken, setTokenSecure } from "@/lib/token-storage";
import { requestActivityPermission } from "@/modules/activity-transition";
import { Redirect } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, PermissionsAndroid, Platform, Text, View } from "react-native";
import {
  BatteryOptEnabled,
  RequestDisableOptimization,
} from "react-native-battery-optimization-check";

export default function IndexScreen() {
  const [isReady, setIsReady] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const checkingRef = useRef(false);

  // 시스템의 "배터리 최적화 제외" 대화상자를 띄우고 닫힐 때까지 기다린다.
  // 대화상자가 떠 있는 동안 앱은 background가 되고, 닫히면 active로 돌아온다.
  const requestBatteryExemption = () =>
    new Promise<void>((resolve) => {
      let left = false;
      const sub = AppState.addEventListener("change", (state) => {
        if (state !== "active") left = true;
        else if (left) {
          sub.remove();
          resolve();
        }
      });
      // 대화상자를 띄우지 않는 기기(제조사 정책)에서는 앱이 떠나지 않으므로 잠시 뒤 그대로 진행한다
      setTimeout(() => {
        if (left) return;
        sub.remove();
        resolve();
      }, 1500);
      RequestDisableOptimization();
    });

  // prompt=false면 묻지 않고 확인만 한다. 설정에서 돌아왔을 때 다시 요청하면, 대화상자를 닫는 순간
  // 앱이 다시 active가 되어 또 요청하는 반복이 생긴다.
  const checkPermissions = async (prompt = true): Promise<{
    ble: boolean;
    gps: boolean;
    battery: boolean;
    notification: boolean;
  }> => {
    const ble = prompt ? await requestBluetoothPermission() : await checkBluetoothPermission();
    const gps = prompt ? await requestLocationPermissions() : await checkLocationPermissions();
    // 먼저 최적화 제외를 요청하고, 그래도 안 됐을 때만 안내(showPermissionBlocker) 대상이 된다
    let battery = Platform.OS === "android" ? !(await BatteryOptEnabled()) : true;
    if (!battery && prompt) {
      await requestBatteryExemption();
      battery = !(await BatteryOptEnabled());
    }
    let notification = true;
    if (Platform.OS === "android" && parseInt(Platform.Version.toString(), 10) >= 33) {
      notification = prompt
        ? (await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS)) ===
          PermissionsAndroid.RESULTS.GRANTED
        : await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
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
    showAlert(
      "권한 필요",
      `다음 권한을 허용해주세요\n${missing}`,
      [
        { text: "설정 열기", onPress: () => Linking.openSettings() },
        {
          text: "재확인",
          onPress: async () => {
            // 요청 대화상자가 오가는 동안 아래 AppState 재확인이 끼어들어 안내를 겹쳐 띄우지 않게 막는다
            checkingRef.current = true;
            try {
              const { ble: b, gps: g, battery: bat, notification: n } = await checkPermissions();
              if (b && g && bat && n) {
                setPermissionDenied(false);
                await checkAndSetAuth();
                // await setupBgLocation();
                // await startBgLocationTask();
                await startBackground();
              } else {
                showPermissionBlocker(b, g, bat, n);
              }
            } finally {
              checkingRef.current = false;
            }
          },
        },
      ],
    );
    setPermissionDenied(true);
  };

  // 지오펜스 등록 + 신체 활동 권한(걸음 센서) 요청. 지오펜스 등록이 실패해도(위치 꺼짐·백그라운드 위치 권한 없음) 권한은 요청한다.
  const startBackground = async () => {
    try {
      await updateGeoFence();
    } catch (e) {
      appendSystemLog({ event_name: "entry", log_type: "ERROR", message: `geofence register failed: ${e}` });
      authLog("ERROR", `지오펜스 등록 실패: ${e}`);
    }
    await requestActivityPermission();
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
      // 지오펜스 + 걸음 센서 권한 (N3 릴레이 완화: 오래 정지 중이면 자동 해제 거부)
      await startBackground();
    })();
  }, []);

  // 설정에서 돌아왔을 때 권한 재확인 (확인만 한다 — checkPermissions 주석 참고)
  useEffect(() => {
    if (!permissionDenied) return;
    const sub = AppState.addEventListener("change", async (state) => {
      if (state !== "active" || checkingRef.current) return;
      checkingRef.current = true;
      try {
        const { ble, gps, battery, notification } = await checkPermissions(false);
        if (ble && gps && battery && notification) {
          setPermissionDenied(false);
          // 권한 받은 이후 로직 시작
          await checkAndSetAuth();
          await startBackground();
        } else {
          showPermissionBlocker(ble, gps, battery, notification);
        }
      } finally {
        checkingRef.current = false;
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
