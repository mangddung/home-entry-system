import { requestBluetoothPermission } from "@/hooks/request-ble-permit";
import { refreshToken } from "@/lib/api/auth";
import { clearDeviceStorage } from "@/lib/api/devices";
import { revokeFcmToken } from "@/lib/api/fcm";
import { cancelTrackingNotification } from "@/lib/background-tracking";
import { BG_GEOFENCE_TASK, BG_LOCATION_TASK, CURRENT_LOCATION_KEY, DEVICE_STATUS_KEY, IS_ONLINE_KEY, SELECTED_DEVICE_KEY, UNFIGURED_DEVICES_KEY, USER_ACCESS_TOKEN_KEY, USER_NAME_KEY, USER_REFRESH_TOKEN_KEY, USER_SECRET_KEY, USER_UUID_KEY } from "@/lib/constants";
import { setTokenSecure } from "@/lib/token-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { AlertButton, CustomAlert } from "@/components/custom-alert";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Provider } from "@ant-design/react-native";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { PermissionsAndroid, Platform, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

async function checkBlePermission(): Promise<boolean> {
  if (Platform.OS === "ios") return true;
  const apiLevel = parseInt(Platform.Version.toString(), 10);
  if (apiLevel < 31) {
    return await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  }
  const scan = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN);
  const connect = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
  const location = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return scan && connect && location;
}

type SettingRowProps = {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>["name"];
  iconColor: string;
  iconBg: string;
  label: string;
  chevron?: boolean;
  rightContent?: React.ReactNode;
  onPress?: () => void;
  textColor: string;
};

function SettingRow({ icon, iconColor, iconBg, label, chevron = true, rightContent, onPress, textColor }: SettingRowProps) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={onPress ? 0.7 : 1}>
      <View style={[styles.rowIcon, { backgroundColor: iconBg }]}>
        <MaterialCommunityIcons name={icon} size={18} color={iconColor} />
      </View>
      <Text style={[styles.rowLabel, { color: textColor }]}>{label}</Text>
      <View style={styles.rowRight}>
        {rightContent}
        {chevron && <MaterialCommunityIcons name="chevron-right" size={18} color="#9BA1A6" />}
      </View>
    </TouchableOpacity>
  );
}

export default function SettingsScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const [bleGranted, setBleGranted] = useState<boolean | null>(null);
  const [alertConfig, setAlertConfig] = useState<{ title: string; message?: string; buttons?: AlertButton[] } | null>(null);

  const showAlert = (title: string, message?: string, buttons?: AlertButton[]) =>
    setAlertConfig({ title, message, buttons });

  const cardBg = isDark ? "#1e2022" : "#f3f4f6";
  const dividerColor = isDark ? "#2a2d2e" : "#e5e7eb";

  useEffect(() => {
    checkBlePermission().then(setBleGranted);
  }, []);

  const handleRequestBle = async () => {
    const granted = await requestBluetoothPermission();
    setBleGranted(granted);
  };

  const logout = () => {
    showAlert("로그아웃", "정말 로그아웃 하시겠습니까?", [
      { text: "취소", onPress: () => setAlertConfig(null) },
      {
        text: "로그아웃",
        style: "destructive",
        onPress: async () => {
          setAlertConfig(null);
          await revokeFcmToken();
          await setTokenSecure(USER_SECRET_KEY, "");
          await setTokenSecure(USER_NAME_KEY, "");
          await setTokenSecure(USER_UUID_KEY, "");
          await setTokenSecure(USER_ACCESS_TOKEN_KEY, "");
          await setTokenSecure(USER_REFRESH_TOKEN_KEY, "");
          await clearDeviceStorage();
          await setTokenSecure(UNFIGURED_DEVICES_KEY, "");
          await setTokenSecure(SELECTED_DEVICE_KEY, "");
          await setTokenSecure(IS_ONLINE_KEY, "");
          await setTokenSecure(CURRENT_LOCATION_KEY, "");
          await setTokenSecure(DEVICE_STATUS_KEY, "");
          try {
            const isRegistered = await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK);
            if (isRegistered) {
              await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
            }
            const isGeofenceRegistered = await TaskManager.isTaskRegisteredAsync(BG_GEOFENCE_TASK);
            if (isGeofenceRegistered) {
              await Location.stopGeofencingAsync(BG_GEOFENCE_TASK);
            }
            await cancelTrackingNotification();
          } catch {
            // ignore if task is not actually running
          }
          router.push("/login-oauth");
        },
      },
    ]);
  };

  return (
    <Provider>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        {/* 헤더 */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>설정</Text>
        </View>

        {/* 권한 섹션 */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.icon }]}>권한</Text>
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <SettingRow
              icon="bluetooth"
              iconColor="#fff"
              iconBg="#3b82f6"
              label="블루투스 권한"
              textColor={colors.text}
              chevron={bleGranted === false}
              onPress={bleGranted === false ? handleRequestBle : undefined}
              rightContent={
                bleGranted !== null ? (
                  <View style={[styles.badge, { backgroundColor: bleGranted ? "#dcfce7" : "#fee2e2" }]}>
                    <Text style={[styles.badgeText, { color: bleGranted ? "#15803d" : "#b91c1c" }]}>
                      {bleGranted ? "허용됨" : "거부됨"}
                    </Text>
                  </View>
                ) : null
              }
            />
          </View>
        </View>

        {/* 개발자 도구 섹션 */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.icon }]}>개발자 도구</Text>
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <SettingRow
              icon="refresh"
              iconColor="#fff"
              iconBg="#8b5cf6"
              label="토큰 갱신"
              textColor={colors.text}
              onPress={async () => {
                const result = await refreshToken();
                showAlert(result.type === "success" ? "성공" : "오류", result.message);
              }}
            />
            <View style={[styles.divider, { backgroundColor: dividerColor }]} />
            <SettingRow
              icon="text-box-outline"
              iconColor="#fff"
              iconBg="#0891b2"
              label="시스템 로그"
              textColor={colors.text}
              onPress={() => router.push("/system-log-view")}
            />
          </View>
        </View>

        {/* 계정 섹션 */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.icon }]}>계정</Text>
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <SettingRow
              icon="logout"
              iconColor="#fff"
              iconBg="#ef4444"
              label="로그아웃"
              textColor="#ef4444"
              onPress={logout}
            />
          </View>
        </View>
      </ScrollView>
      <CustomAlert
        visible={!!alertConfig}
        title={alertConfig?.title ?? ""}
        message={alertConfig?.message}
        buttons={alertConfig?.buttons ?? [{ text: "확인", onPress: () => setAlertConfig(null) }]}
        onRequestClose={() => setAlertConfig(null)}
      />
    </Provider>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 24,
  },
  header: {
    paddingVertical: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  card: {
    borderRadius: 14,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  rowIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  rowLabel: {
    flex: 1,
    fontSize: 15,
  },
  rowRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: "600",
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 60,
  },
});
