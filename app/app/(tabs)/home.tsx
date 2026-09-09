import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { verifyToken } from "@/lib/api/auth";
import { fetchDevices, fetchUnconfiguredDevices, loadDevices } from "@/lib/api/devices";
import { sweepOrphanBonds } from "@/lib/bond";
import { updateGeoFence } from "@/lib/background-tracking";
import { loadFcmNotifications, getFcmLastReadAt, setFcmLastReadAt, type FcmNotificationItem } from "@/lib/fcm-log";
import {
  IS_ONLINE_KEY,
  SELECTED_DEVICE_KEY,
  UNFIGURED_DEVICES_KEY,
} from "@/lib/constants";
import { checkAuthToken, getTokenSecure, setTokenSecure } from "@/lib/token-storage";
import { IoTDevice } from "@/lib/types";
import { Provider } from "@ant-design/react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useIsFocused } from "@react-navigation/native";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Image, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

const ROLE_ORDER: Record<string, number> = { master: 0, member: 1, guest: 2 };

function getRoleAccent(role: string, isDark: boolean) {
  switch (role) {
    case "master":
      return {
        icon: "crown" as const,
        label: "마스터",
        borderColor: isDark ? "#FBBF24" : "#F59E0B",
        pillBg: isDark ? "rgba(251,191,36,0.15)" : "#FEF3C7",
        pillColor: isDark ? "#FBBF24" : "#D97706",
      };
    case "member":
      return {
        icon: "account" as const,
        label: "멤버",
        borderColor: isDark ? "#60A5FA" : "#3B82F6",
        pillBg: isDark ? "rgba(96,165,250,0.15)" : "#DBEAFE",
        pillColor: isDark ? "#60A5FA" : "#2563EB",
      };
    default:
      return {
        icon: "account-outline" as const,
        label: "게스트",
        borderColor: isDark ? "#4B5563" : "#D1D5DB",
        pillBg: isDark ? "rgba(156,163,175,0.15)" : "#F3F4F6",
        pillColor: isDark ? "#9CA3AF" : "#6B7280",
      };
  }
}

function getPingColor(lastPingAt: Date | string | null | undefined): string {
  if (!lastPingAt) return "#ef4444";
  const diff = (Date.now() - new Date(lastPingAt).getTime()) / 60000;
  if (diff <= 5) return "#22c55e";
  if (diff <= 10) return "#eab308";
  return "#ef4444";
}

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const [isOnline, setIsOnline] = useState(false);
  const [userDeviecs, setUserDevices] = useState<IoTDevice[] | null>(null);
  const [unconfiguredLocationDevice, setUnconfiguredLocationDevice] = useState<{
    device_uuid: string;
  } | null>(null);
  const [notifications, setNotifications] = useState<FcmNotificationItem[]>([]);
  const [notifModalVisible, setNotifModalVisible] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [lastReadAt, setLastReadAt] = useState<Date>(new Date(0));

  const isFocused = useIsFocused();

  useEffect(() => {
    if (!isFocused) return;

    const refreshDevices = async () => {
      await fetchDevices();
      setUserDevices(await loadDevices());
      await updateGeoFence();
      void sweepOrphanBonds();
    };

    void (async () => {
      const initializeTf = await checkAuthToken();
      if (!initializeTf) {
        router.push("/login-oauth");
        return;
      }
      const result = await verifyToken();
      if (result.type === "success") {
        await setTokenSecure(IS_ONLINE_KEY, "true");
        setIsOnline(true);
      } else if (result.type === "no_response" || initializeTf) {
        await setTokenSecure(IS_ONLINE_KEY, "false");
        setIsOnline(false);
      } else {
        router.push("/login-oauth");
        return;
      }
      const notifs = await loadFcmNotifications();
      const readAt = await getFcmLastReadAt();
      setNotifications(notifs);
      setLastReadAt(readAt);
      setUnreadCount(notifs.filter(n => new Date(n.timestamp) > readAt).length);
      const isOnlineNow = result.type === "success";
      if (isOnlineNow) {
        await refreshDevices();
        await fetchUnconfiguredDevices();
        const unfigured = await getTokenSecure(UNFIGURED_DEVICES_KEY);
        if (unfigured) {
          const list = JSON.parse(unfigured) as { device_uuid: string; type: string }[];
          const found = list.find((d) => d.type === "location") ?? null;
          setUnconfiguredLocationDevice(found);
        }
      }
    })();

    const interval = setInterval(() => { void refreshDevices(); }, 30_000);
    return () => clearInterval(interval);
  }, [isFocused]);

  const cardBg = isDark ? "#1e2022" : "#f3f4f6";
  const dividerColor = isDark ? "#2a2d2e" : "#e5e7eb";

  return (
    <Provider>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={styles.container}
        showsVerticalScrollIndicator={false}
      >
        {/* 헤더 */}
        <View style={styles.header}>
          <Text style={[styles.headerTitle, { color: colors.text }]}>내 기기</Text>
          <View style={styles.headerRight}>
            <TouchableOpacity
              onPress={async () => {
                setNotifications(await loadFcmNotifications());
                setNotifModalVisible(true);
              }}
              style={styles.bellButton}
            >
              <MaterialCommunityIcons name="bell-outline" size={22} color={colors.text} />
              {unreadCount > 0 && (
                <View style={styles.bellBadge}>
                  <Text style={styles.bellBadgeText}>{unreadCount > 9 ? "9+" : unreadCount}</Text>
                </View>
              )}
            </TouchableOpacity>
            <View style={[styles.statusBadge, { backgroundColor: isOnline ? "#dcfce7" : "#fee2e2" }]}>
              <View style={[styles.statusDot, { backgroundColor: isOnline ? "#22c55e" : "#ef4444" }]} />
              <Text style={[styles.statusText, { color: isOnline ? "#15803d" : "#b91c1c" }]}>
                {isOnline ? "온라인" : "오프라인"}
              </Text>
            </View>
          </View>
        </View>

        {/* 미완료 위치 설정 배너 */}
        {unconfiguredLocationDevice && (
          <TouchableOpacity
            style={styles.setupBanner}
            onPress={() => router.push("/device/location-setup")}
            activeOpacity={0.8}
          >
            <View style={styles.setupBannerLeft}>
              <MaterialCommunityIcons name="map-marker-alert-outline" size={22} color="#D97706" />
              <View style={{ gap: 2 }}>
                <Text style={styles.setupBannerTitle}>위치 설정이 완료되지 않았습니다</Text>
                <Text style={styles.setupBannerUuid} numberOfLines={1}>
                  {unconfiguredLocationDevice.device_uuid.slice(0, 8)}…
                </Text>
              </View>
            </View>
            <MaterialCommunityIcons name="chevron-right" size={20} color="#D97706" />
          </TouchableOpacity>
        )}

        {/* 등록된 기기 */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.icon }]}>등록된 기기</Text>
          {userDeviecs && userDeviecs.length > 0 ? (
            <View style={styles.list}>
              {[...userDeviecs].sort((a, b) => (ROLE_ORDER[a.role] ?? 3) - (ROLE_ORDER[b.role] ?? 3)).map((device) => {
                const roleAccent = getRoleAccent(device.role, isDark);
                const pingColor = getPingColor(device.last_ping_at);
                const pingLabel = pingColor === "#22c55e" ? "온라인" : pingColor === "#eab308" ? "대기중" : "오프라인";
                return (
                  <TouchableOpacity
                    key={device.device_uuid}
                    style={[
                      styles.card,
                      {
                        backgroundColor: cardBg,
                        borderWidth: 1,
                        borderColor: isDark ? "#2C3237" : "#E5E7EB",
                        borderLeftWidth: 3,
                        borderLeftColor: roleAccent.borderColor,
                      },
                    ]}
                    onPress={async () => {
                      await setTokenSecure(SELECTED_DEVICE_KEY, JSON.stringify(device));
                      router.push("/device/device_info");
                    }}
                  >
                    <View style={[styles.cardIconWrap, { backgroundColor: roleAccent.pillBg }]}>
                      <Image source={require("@/assets/images/icon-door-lock.png")} style={styles.icon} />
                    </View>
                    <View style={styles.cardContent}>
                      <Text style={[styles.cardPrimary, { color: colors.text }]} numberOfLines={1}>
                        {device.device_nickname || `${device.device_uuid.slice(0, 8)}...`}
                      </Text>
                      {!!device.device_nickname && (
                        <Text style={[styles.cardSecondary, { color: colors.icon }]} numberOfLines={1}>
                          {device.device_uuid.slice(0, 8)}…
                        </Text>
                      )}
                      {!device.auth_token && (
                        <View style={styles.tokenWarnRow}>
                          <MaterialCommunityIcons name="key-alert-outline" size={11} color="#D97706" />
                          <Text style={styles.tokenWarnText}>토큰 없음</Text>
                        </View>
                      )}
                    </View>
                    <View style={styles.cardRight}>
                      <View style={[styles.roleChip, { backgroundColor: roleAccent.pillBg }]}>
                        <MaterialCommunityIcons name={roleAccent.icon} size={11} color={roleAccent.pillColor} />
                        <Text style={[styles.roleChipText, { color: roleAccent.pillColor }]}>{roleAccent.label}</Text>
                      </View>
                      <View style={styles.pingRow}>
                        <View style={[styles.pingDot, { backgroundColor: pingColor }]} />
                        <Text style={[styles.pingLabel, { color: pingColor }]}>{pingLabel}</Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          ) : (
            <View style={[styles.emptyState, { backgroundColor: cardBg }]}>
              <Text style={[styles.emptyText, { color: colors.icon }]}>등록된 기기가 없습니다</Text>
            </View>
          )}
        </View>

        {/* 바로가기 */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.icon }]}>바로가기</Text>
          <View style={[styles.actionList, { backgroundColor: cardBg }]}>
            {isOnline && (
              <>
                <TouchableOpacity
                  style={styles.actionItem}
                  onPress={() => router.push("/device/device_setup")}
                >
                  <Text style={[styles.actionText, { color: colors.text }]}>기기 추가</Text>
                  <Text style={[styles.chevron, { color: colors.icon }]}>›</Text>
                </TouchableOpacity>
                <View style={[styles.divider, { backgroundColor: dividerColor }]} />
                <TouchableOpacity
                  style={styles.actionItem}
                  onPress={() => router.push("/register_invite_code")}
                >
                  <Text style={[styles.actionText, { color: colors.text }]}>초대 코드 가입</Text>
                  <Text style={[styles.chevron, { color: colors.icon }]}>›</Text>
                </TouchableOpacity>
                <View style={[styles.divider, { backgroundColor: dividerColor }]} />
              </>
            )}
            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => router.push("/device/device_debug")}
            >
              <Text style={[styles.actionText, { color: colors.text }]}>디바이스 디버그</Text>
              <Text style={[styles.chevron, { color: colors.icon }]}>›</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      <Modal
        visible={notifModalVisible}
        transparent
        animationType="slide"
        onRequestClose={async () => {
          await setFcmLastReadAt();
          setLastReadAt(new Date());
          setUnreadCount(0);
          setNotifModalVisible(false);
        }}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={async () => {
              await setFcmLastReadAt();
              setLastReadAt(new Date());
              setUnreadCount(0);
              setNotifModalVisible(false);
            }}
          />
          <View style={[styles.modalSheet, { backgroundColor: colors.background }]}>
            <View style={styles.modalHandle} />
            <Text style={[styles.modalTitle, { color: colors.text }]}>알림</Text>
            {notifications.length === 0 ? (
              <Text style={styles.notifEmpty}>수신된 알림이 없습니다</Text>
            ) : (
              <FlatList
                data={notifications}
                keyExtractor={(_, i) => String(i)}
                ItemSeparatorComponent={() => <View style={[styles.divider, { backgroundColor: dividerColor }]} />}
                renderItem={({ item }) => {
                  const isNew = new Date(item.timestamp) > lastReadAt;
                  return (
                    <View style={styles.notifItem}>
                      {isNew && <View style={styles.notifNewDot} />}
                      <View style={{ flex: 1, gap: 2 }}>
                        {item.title && <Text style={[styles.notifTitle, { color: colors.text }]}>{item.title}</Text>}
                        {item.body && <Text style={[styles.notifBody, { color: colors.icon }]}>{item.body}</Text>}
                        <Text style={styles.notifTime}>{new Date(item.timestamp).toLocaleString()}</Text>
                      </View>
                    </View>
                  );
                }}
              />
            )}
          </View>
        </View>
      </Modal>
    </Provider>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 16,
    gap: 24,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 8,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: "700",
  },
  statusBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusText: {
    fontSize: 13,
    fontWeight: "600",
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
  list: {
    gap: 8,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderRadius: 14,
    padding: 12,
  },
  cardIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    width: 26,
    height: 26,
  },
  pingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  cardContent: {
    flex: 1,
    gap: 3,
  },
  cardRight: {
    alignItems: "flex-end",
    gap: 6,
  },
  cardPrimary: {
    fontSize: 14,
    fontWeight: "600",
  },
  cardSecondary: {
    fontSize: 11,
    fontFamily: "monospace",
  },
  roleChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 8,
  },
  roleChipText: {
    fontSize: 11,
    fontWeight: "600",
  },
  setupBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "#FEF3C7",
    borderWidth: 1,
    borderColor: "#FDE68A",
    borderRadius: 14,
    padding: 14,
  },
  setupBannerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  setupBannerTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#92400E",
  },
  setupBannerUuid: {
    fontSize: 11,
    color: "#B45309",
    fontFamily: "monospace",
  },
  emptyState: {
    padding: 28,
    borderRadius: 14,
    alignItems: "center",
  },
  emptyText: {
    fontSize: 14,
  },
  actionList: {
    borderRadius: 14,
    overflow: "hidden",
  },
  actionItem: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  actionText: {
    fontSize: 15,
  },
  chevron: {
    fontSize: 20,
    lineHeight: 22,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
  pingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  pingLabel: {
    fontSize: 11,
    fontWeight: "600",
  },
  tokenWarnRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  tokenWarnText: {
    fontSize: 11,
    fontWeight: "600",
    color: "#D97706",
  },
  notifList: {
    borderRadius: 14,
    overflow: "hidden",
  },
  notifItem: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  notifTitle: {
    fontSize: 13,
    fontWeight: "600",
  },
  notifBody: {
    fontSize: 12,
  },
  notifTime: {
    fontSize: 11,
    color: "#9CA3AF",
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  bellButton: {
    padding: 4,
  },
  bellBadge: {
    position: "absolute",
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },
  bellBadgeText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "700",
  },
  notifNewDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: "#ef4444",
    marginTop: 5,
    marginRight: 2,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 16,
    maxHeight: "70%",
  },
  modalHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#D1D5DB",
    alignSelf: "center",
    marginBottom: 16,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 12,
  },
  notifEmpty: {
    textAlign: "center",
    color: "#9CA3AF",
    paddingVertical: 24,
  },
});
