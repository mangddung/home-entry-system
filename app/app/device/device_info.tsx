import { AlertButton, CustomAlert } from "@/components/custom-alert";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { deleteDevice, deleteMemberShip, updateDeviceName } from "@/lib/api/devices";
import { fetchDeviceLogs, type DeviceLog } from "@/lib/api/logs";
import { userTokenExchange } from "@/lib/ble";
import {
  createGuestToken,
  createInviteCode,
  deleteGuestToken,
  deleteInviteCode,
  deleteMember as deleteMemberFromTeam,
  fetchGuestTokens,
  fetchInviteCode,
  fetchMember,
} from "@/lib/api/members";
import { GEOFENCE_RADIUS_M, SELECTED_DEVICE_KEY, USER_UUID_KEY } from "@/lib/constants";
import { getTokenSecure } from "@/lib/token-storage";
import { MemberInfo, type IoTDevice } from "@/lib/types";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import Clipboard from "@react-native-clipboard/clipboard";
import DateTimePicker from "@react-native-community/datetimepicker";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

const mapHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    #map { width: 100%; height: 100vh; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map').setView([37.5665, 126.9780], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    var layers = [];
    function setDevice(d) {
      layers.forEach(function(l) { map.removeLayer(l); });
      layers = [];
      var lat = d.latitude, lon = d.longitude, range = ${GEOFENCE_RADIUS_M};
      var icon = L.divIcon({
        className: '',
        html: '<div style="background:#0a7ea4;color:#fff;padding:3px 8px;border-radius:6px;font-size:11px;font-weight:600;white-space:nowrap;">장치</div>',
        iconSize: [40, 22],
        iconAnchor: [20, 34]
      });
      var m = L.marker([lat, lon], { icon: icon }).addTo(map)
        .bindPopup('범위: ' + range + 'm');
      var c = L.circle([lat, lon], { radius: range, color: '#0a7ea4', fillOpacity: 0.1 }).addTo(map);
      layers.push(m, c);
      map.setView([lat, lon], 15);
    }
  </script>
</body>
</html>
`;

function getActionLabel(action: string): string {
  const map: Record<string, string> = {
    device_registered: "기기 등록",
    device_updated: "기기 정보 수정",
    device_deleted: "기기 삭제",
    token_validated: "출입 인증",
    member_added: "멤버 추가",
    member_removed: "멤버 제거",
    member_role_updated: "역할 변경",
  };
  return map[action] ?? action;
}

function formatLogTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `${d.getMonth() + 1}/${d.getDate()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function getPingColor(lastPingAt: Date | string | null | undefined): string {
  if (!lastPingAt) return "#ef4444";
  const diff = (Date.now() - new Date(lastPingAt).getTime()) / 60000;
  if (diff <= 5) return "#22c55e";
  if (diff <= 10) return "#eab308";
  return "#ef4444";
}

function getTimeLeft(expiredAt: string) {
  const diff = new Date(expiredAt).getTime() - Date.now();
  if (diff <= 0) return "만료됨";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 24) return `${hours}시간 후 만료`;
  return `${Math.floor(hours / 24)}일 후 만료`;
}

function getExpiredBadgeStyle(expiredAt: string, isDark: boolean) {
  const diff = new Date(expiredAt).getTime() - Date.now();
  if (diff <= 0) return { bg: isDark ? "rgba(239,68,68,0.15)" : "#FEE2E2", color: "#EF4444" };
  if (diff < 12 * 3600 * 1000)
    return { bg: isDark ? "rgba(245,158,11,0.15)" : "#FEF3C7", color: "#F59E0B" };
  return { bg: isDark ? "rgba(34,197,94,0.15)" : "#DCFCE7", color: "#16A34A" };
}

function getRoleStyle(role: string, isDark: boolean) {
  switch (role) {
    case "master":
      return {
        icon: "crown" as const,
        label: "마스터",
        bg: isDark ? "rgba(251,191,36,0.15)" : "#FEF3C7",
        color: isDark ? "#FBBF24" : "#D97706",
      };
    case "member":
      return {
        icon: "account" as const,
        label: "멤버",
        bg: isDark ? "rgba(96,165,250,0.15)" : "#DBEAFE",
        color: isDark ? "#60A5FA" : "#2563EB",
      };
    case "guest":
      return {
        icon: "account-outline" as const,
        label: "게스트",
        bg: isDark ? "rgba(156,163,175,0.15)" : "#F3F4F6",
        color: isDark ? "#9CA3AF" : "#6B7280",
      };
    default:
      return {
        icon: "help-circle-outline" as const,
        label: role,
        bg: isDark ? "rgba(156,163,175,0.15)" : "#F3F4F6",
        color: isDark ? "#9CA3AF" : "#6B7280",
      };
  }
}

export default function DeviceInfoView() {
  const scheme = useColorScheme();
  const colors = Colors[scheme ?? "light"];
  const isDark = scheme === "dark";
  const cardBg = isDark ? "#1E2124" : "#F8FAFC";
  const cardBorder = isDark ? "#2C3237" : "#E2E8F0";
  const modalBg = isDark ? "#1E2124" : "#FFFFFF";

  const [myUuid, setMyUuid] = useState<string | null>(null);
  const [device, setDevice] = useState<IoTDevice | null>(null);
  const [deviceMember, setDeviceMember] = useState<MemberInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const webViewRef = useRef<WebView>(null);
  const mapReadyRef = useRef(false);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [inviteResult, setInviteResult] = useState<{
    display_name: string;
    invite_code: string;
  } | null>(null);

  const [isLogModalOpen, setIsLogModalOpen] = useState(false);
  const [inviteCodes, setInviteCodes] = useState<
    {
      invite_code: string;
      display_name: string;
      role?: string;
      created_at?: string;
      expired_at?: string;
    }[]
  >([]);
  const [isLogLoading, setIsLogLoading] = useState(false);

  const [inviteRole, setInviteRole] = useState<"member" | "guest">("member");

  const [isNicknameModalOpen, setIsNicknameModalOpen] = useState(false);
  const [nicknameInput, setNicknameInput] = useState("");

  const [guestTokenTarget, setGuestTokenTarget] = useState<MemberInfo | null>(null);
  const [guestTokenMaxUses, setGuestTokenMaxUses] = useState(1);
  const [guestTokenExpireValue, setGuestTokenExpireValue] = useState("3");
  const [guestTokenExpireUnit, setGuestTokenExpireUnit] = useState<"분" | "시" | "일">("일");
  const [guestTokenShowExtra, setGuestTokenShowExtra] = useState(false);
  const [guestTokenNotBeforeDate, setGuestTokenNotBeforeDate] = useState<Date | null>(null);
  const [guestTokenPickerStep, setGuestTokenPickerStep] = useState<"date" | "time" | null>(null);
  const [guestTokenLoading, setGuestTokenLoading] = useState(false);
  const [selectedMember, setSelectedMember] = useState<MemberInfo | null>(null);
  const [selectedMemberTokens, setSelectedMemberTokens] = useState<{
    id: number;
    max_uses: number | null;
    use_count: number;
    not_before: string | null;
    expired_at: string | null;
    created_at: string | null;
  }[]>([]);
  const [selectedMemberTokensLoading, setSelectedMemberTokensLoading] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const [isActivityLogOpen, setIsActivityLogOpen] = useState(false);
  const [activityLogs, setActivityLogs] = useState<DeviceLog[]>([]);
  const [activityLogLoading, setActivityLogLoading] = useState(false);
  const [activityLogError, setActivityLogError] = useState("");
  const [activityLogTab, setActivityLogTab] = useState<"device" | "access" | "member">("device");

  const loadActivityLogs = async (category: "device" | "access" | "member", deviceUuid: string) => {
    setActivityLogLoading(true);
    setActivityLogError("");
    const result = await fetchDeviceLogs(deviceUuid, category);
    setActivityLogLoading(false);
    if (result.type === "success") {
      setActivityLogs(result.data);
    } else {
      setActivityLogError(result.message ?? "로그를 불러오지 못했습니다.");
    }
  };

  const openActivityLog = async () => {
    if (!device) return;
    setIsActivityLogOpen(true);
    await loadActivityLogs(activityLogTab, device.device_uuid);
  };

  const handleManualAuth = async () => {
    if (!device) return;
    if (getPingColor(device.last_ping_at) === "#ef4444") {
      showAlert("오류", "기기가 오프라인 상태입니다.");
      return;
    }
    setIsAuthenticating(true);
    try {
      const success = await userTokenExchange(device);
      if (success) {
        showAlert("수동 인증", "인증 요청이 완료되었습니다.");
      } else {
        showAlert("오류", "기기에 연결할 수 없습니다. 기기가 오프라인 상태이거나 범위 밖에 있는지 확인하세요.");
      }
    } catch {
      showAlert("오류", "인증 중 오류가 발생했습니다.");
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleGuestTokenClose = () => {
    setGuestTokenTarget(null);
    setGuestTokenMaxUses(1);
    setGuestTokenExpireValue("3");
    setGuestTokenExpireUnit("일");
    setGuestTokenShowExtra(false);
    setGuestTokenNotBeforeDate(null);
    setGuestTokenPickerStep(null);
  };

  const handleGuestTokenConfirm = async () => {
    if (!device || !guestTokenTarget) return;
    setGuestTokenLoading(true);
    const unitToMinutes = { 분: 1, 시: 60, 일: 1440 };
    const expire_minutes = guestTokenExpireValue
      ? parseInt(guestTokenExpireValue, 10) * unitToMinutes[guestTokenExpireUnit]
      : undefined;
    console;
    const result = await createGuestToken(
      device.device_uuid,
      guestTokenTarget.user_uuid,
      guestTokenMaxUses || undefined,
      guestTokenNotBeforeDate?.toISOString() || undefined,
      expire_minutes,
    );
    setGuestTokenLoading(false);
    if (result.type === "success") {
      handleGuestTokenClose();
      showAlert("완료", "게스트 토큰이 발급되었습니다.");
    } else {
      showAlert("오류", result.message ?? "오류가 발생했습니다.");
    }
  };

  const [deleteVisible, setDeleteVisible] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  const [alertConfig, setAlertConfig] = useState<{
    title: string;
    message?: string;
    buttons?: AlertButton[];
  } | null>(null);
  const showAlert = (title: string, message?: string, buttons?: AlertButton[]) =>
    setAlertConfig({ title, message, buttons });

  const handleNicknameConfirm = async () => {
    if (!device || !nicknameInput.trim()) return;
    const result = await updateDeviceName(device.device_uuid, nicknameInput.trim());
    if (result.type === "success") {
      setDevice((prev) => (prev ? { ...prev, device_nickname: nicknameInput.trim() } : prev));
      setIsNicknameModalOpen(false);
      setNicknameInput("");
    } else {
      showAlert("오류", result.message ?? "오류가 발생했습니다.");
    }
  };

  const openLogModal = async () => {
    if (!device) return;
    setIsLogModalOpen(true);
    setIsLogLoading(true);
    const result = await fetchInviteCode(device.device_uuid);
    if (result.type === "success") setInviteCodes(result.data as typeof inviteCodes);
    setIsLogLoading(false);
  };

  const handleDeleteMember = (member: MemberInfo) => {
    showAlert("멤버 삭제", `${member.display_name}을(를) 멤버에서 삭제하시겠습니까?`, [
      { text: "취소", style: "cancel" },
      {
        text: "삭제",
        style: "destructive",
        onPress: async () => {
          if (!device) return;
          const result = await deleteMemberFromTeam(member.user_uuid, device.device_uuid);
          if (result.type === "success") {
            setDeviceMember((prev) => prev.filter((m) => m.user_uuid !== member.user_uuid));
          } else {
            showAlert("삭제 실패", result.message ?? "오류가 발생했습니다.");
          }
        },
      },
    ]);
  };

  const handleDelete = (invite_code: string) => {
    showAlert("초대 코드 삭제", "이 코드를 삭제하시겠습니까?", [
      { text: "취소", style: "cancel" },
      {
        text: "삭제",
        style: "destructive",
        onPress: async () => {
          const result = await deleteInviteCode(invite_code);
          if (result.type === "success") {
            setInviteCodes((prev) => prev.filter((c) => c.invite_code !== invite_code));
          }
        },
      },
    ]);
  };

  const handleOk = async () => {
    if (!device) return;
    const result = await createInviteCode(device.device_uuid, displayName, inviteRole);
    if (result.type === "success") {
      const data = result.data as { display_name: string; invite_code: string };
      setInviteResult(data);
    } else {
      showAlert("오류", result.message ?? "오류 발생");
    }
  };

  const handleCancel = () => {
    setIsModalOpen(false);
    setDisplayName("");
    setInviteResult(null);
    setInviteRole("member");
  };

  useEffect(() => {
    void (async () => {
      const [selected_device, uuid] = await Promise.all([
        getTokenSecure(SELECTED_DEVICE_KEY),
        getTokenSecure(USER_UUID_KEY),
      ]);
      if (!selected_device) {
        router.push("/home");
        return;
      }
      setMyUuid(uuid);
      setDevice(JSON.parse(selected_device));
      setIsLoading(false);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      if (!device) return;
      const result = await fetchMember(device.device_uuid);
      if (result.type !== "success") {
        setError(result.message ?? "오류 발생");
      } else {
        setDeviceMember(result.data as MemberInfo[]);
      }
    })();
  }, [device]);

  const injectLocation = (loc: IoTDevice["location"]) => {
    if (!mapReadyRef.current || !loc) return;
    webViewRef.current?.injectJavaScript(`setDevice(${JSON.stringify(loc)}); true;`);
  };

  useEffect(() => {
    injectLocation(device?.location ?? null);
  }, [device]);

  useEffect(() => {
    if (!selectedMember || selectedMember.role !== "guest" || !device) {
      setSelectedMemberTokens([]);
      return;
    }
    void (async () => {
      setSelectedMemberTokensLoading(true);
      const result = await fetchGuestTokens(device.device_uuid, selectedMember.user_uuid);
      if (result.type === "success") {
        setSelectedMemberTokens(result.data as typeof selectedMemberTokens);
      }
      setSelectedMemberTokensLoading(false);
    })();
  }, [selectedMember]);

  if (isLoading) {
    return (
      <SafeAreaView
        style={[styles.centerContainer, { backgroundColor: colors.background }]}
        edges={["top"]}
      >
        <ActivityIndicator size="large" color={colors.tint} />
      </SafeAreaView>
    );
  }

  if (!device) {
    return (
      <SafeAreaView
        style={[styles.centerContainer, { backgroundColor: colors.background }]}
        edges={["top"]}
      >
        <MaterialCommunityIcons name="devices" size={48} color={colors.tabIconDefault} />
        <Text style={[styles.emptyText, { color: colors.tabIconDefault }]}>디바이스 없음</Text>
      </SafeAreaView>
    );
  }

  const myRole = getRoleStyle(device.role, isDark);
  const pingColor = getPingColor(device.last_ping_at);
  const pingLabel =
    pingColor === "#22c55e" ? "온라인" : pingColor === "#eab308" ? "대기" : "오프라인";

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.background }]}
      edges={["top"]}
    >
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* 기기 정보 카드 */}
        <View style={[styles.deviceCard, { backgroundColor: cardBg, borderColor: cardBorder }]}>
          <View style={styles.deviceCardTop}>
            <View
              style={[
                styles.deviceIconCircle,
                { backgroundColor: isDark ? "rgba(10,126,164,0.15)" : "#EFF8FC" },
              ]}
            >
              <Image
                source={require("@/assets/images/icon-door-lock.png")}
                style={styles.deviceIcon}
              />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[styles.devicePrimary, { color: colors.text }]} numberOfLines={1}>
                {device.device_nickname ||
                  `${device.device_uuid.split("-").slice(0, 2).join("-")}...`}
              </Text>
              <Text style={[styles.deviceUuid, { color: colors.tabIconDefault }]}>
                {`${device.device_uuid.split("-").slice(0, 2).join("-")}...`}
              </Text>
            </View>
            <View style={styles.cardActions}>
              <TouchableOpacity
                style={[styles.cardActionBtn, { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6" }]}
                onPress={() => {
                  setNicknameInput(device.device_nickname ?? "");
                  setIsNicknameModalOpen(true);
                }}
              >
                <MaterialCommunityIcons
                  name="pencil-outline"
                  size={15}
                  color={colors.tabIconDefault}
                />
              </TouchableOpacity>
              {!!device.auth_token && (
                <TouchableOpacity
                  style={[
                    styles.cardActionBtn,
                    {
                      backgroundColor: isDark ? "rgba(59,130,246,0.12)" : "#EFF6FF",
                      opacity: isAuthenticating || pingColor === "#ef4444" ? 0.4 : 1,
                    },
                  ]}
                  onPress={handleManualAuth}
                  disabled={isAuthenticating || pingColor === "#ef4444"}
                >
                  {isAuthenticating ? (
                    <ActivityIndicator size={15} color="#3B82F6" />
                  ) : (
                    <MaterialCommunityIcons name="bluetooth-transfer" size={15} color="#3B82F6" />
                  )}
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[
                  styles.cardActionBtn,
                  { backgroundColor: isDark ? "rgba(239,68,68,0.12)" : "#FEF2F2" },
                ]}
                onPress={() => setDeleteVisible(true)}
              >
                <MaterialCommunityIcons
                  name={device.role === "master" ? "delete-outline" : "logout-variant"}
                  size={15}
                  color="#EF4444"
                />
              </TouchableOpacity>
            </View>
          </View>
          <View style={[styles.deviceCardDivider, { backgroundColor: cardBorder }]} />
          <View style={styles.deviceCardBottom}>
            <View style={[styles.rolePill, { backgroundColor: myRole.bg }]}>
              <MaterialCommunityIcons name={myRole.icon} size={12} color={myRole.color} />
              <Text style={[styles.rolePillText, { color: myRole.color }]}>{myRole.label}</Text>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
              <View style={styles.deviceStatus}>
                <View style={[styles.pingDot, { backgroundColor: pingColor }]} />
                <Text style={[styles.deviceStatusText, { color: colors.tabIconDefault }]}>
                  {pingLabel}
                </Text>
              </View>
              <TouchableOpacity
                style={[styles.cardActionBtn, { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6" }]}
                onPress={openActivityLog}
              >
                <MaterialCommunityIcons name="text-box-search-outline" size={15} color={colors.tabIconDefault} />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* 위치 섹션 */}
        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>위치</Text>
          {device.location ? (
            <View style={[styles.mapContainer, { borderColor: cardBorder }]}>
              <WebView
                ref={webViewRef}
                source={{ html: mapHTML }}
                style={{ flex: 1 }}
                javaScriptEnabled
                domStorageEnabled
                originWhitelist={["*"]}
                onLoad={() => {
                  mapReadyRef.current = true;
                  injectLocation(device.location);
                }}
              />
            </View>
          ) : (
            <View style={[styles.emptyMap, { backgroundColor: cardBg, borderColor: cardBorder }]}>
              <MaterialCommunityIcons
                name="map-marker-off-outline"
                size={32}
                color={colors.tabIconDefault}
              />
              <Text style={[styles.emptyMapText, { color: colors.tabIconDefault }]}>
                위치 정보 없음
              </Text>
            </View>
          )}
        </View>

        {/* 멤버 섹션 */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>멤버</Text>
            {device.role === "master" && (
              <View style={styles.sectionActions}>
                <TouchableOpacity
                  style={[
                    styles.actionBtn,
                    {
                      borderColor: colors.tint,
                      backgroundColor: isDark ? "rgba(10,126,164,0.1)" : "#EFF8FC",
                    },
                  ]}
                  onPress={() => setIsModalOpen(true)}
                >
                  <MaterialCommunityIcons
                    name="account-plus-outline"
                    size={14}
                    color={colors.tint}
                  />
                  <Text style={[styles.actionBtnText, { color: colors.tint }]}>초대 코드</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.actionBtn, { borderColor: cardBorder, backgroundColor: cardBg }]}
                  onPress={openLogModal}
                >
                  <MaterialCommunityIcons
                    name="ticket-outline"
                    size={14}
                    color={colors.tabIconDefault}
                  />
                  <Text style={[styles.actionBtnText, { color: colors.tabIconDefault }]}>
                    코드 기록
                  </Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {deviceMember.length === 0 ? (
            <View
              style={[styles.emptyMembers, { backgroundColor: cardBg, borderColor: cardBorder }]}
            >
              <Text style={[styles.emptyMembersText, { color: colors.tabIconDefault }]}>
                멤버가 없습니다
              </Text>
            </View>
          ) : (
            <View style={styles.memberList}>
              {[...deviceMember]
                .sort((a, b) => {
                  const order: Record<string, number> = { master: 0, member: 1, guest: 2 };
                  return (order[a.role] ?? 3) - (order[b.role] ?? 3);
                })
                .map((member) => {
                  const role = getRoleStyle(member.role, isDark);
                  const isSelf = member.user_uuid === myUuid;
                  const isTappable = device.role === "master" && member.role !== "master";
                  const cardStyle = [
                    styles.memberCard,
                    { backgroundColor: cardBg, borderColor: isSelf ? "#22c55e" : cardBorder },
                  ];
                  const cardInner = (
                    <>
                      <View style={[styles.memberIconWrap, { backgroundColor: role.bg }]}>
                        <MaterialCommunityIcons name={role.icon} size={20} color={role.color} />
                      </View>
                      <Text style={[styles.memberName, { color: colors.text }]} numberOfLines={1}>
                        {member.display_name}
                      </Text>
                      <View style={styles.memberCardRight}>
                        <View style={[styles.rolePill, { backgroundColor: role.bg }]}>
                          <Text style={[styles.rolePillText, { color: role.color }]}>
                            {role.label}
                          </Text>
                        </View>
                        {isTappable && (
                          <MaterialCommunityIcons
                            name="chevron-right"
                            size={18}
                            color={colors.tabIconDefault}
                          />
                        )}
                      </View>
                    </>
                  );
                  return isTappable ? (
                    <TouchableOpacity
                      key={member.user_uuid}
                      style={cardStyle}
                      onPress={() => setSelectedMember(member)}
                      activeOpacity={0.7}
                    >
                      {cardInner}
                    </TouchableOpacity>
                  ) : (
                    <View key={member.user_uuid} style={cardStyle}>
                      {cardInner}
                    </View>
                  );
                })}
            </View>
          )}
        </View>
      </ScrollView>

      {/* 초대 코드 생성 모달 */}
      <Modal visible={isModalOpen} transparent animationType="fade" onRequestClose={handleCancel}>
        <Pressable style={styles.modalBackdrop} onPress={handleCancel}>
          <Pressable style={[styles.modalBox, { backgroundColor: modalBg }]}>
            <View style={styles.modalHeader}>
              <MaterialCommunityIcons name="account-plus-outline" size={22} color={colors.tint} />
              <Text style={[styles.modalTitle, { color: colors.text }]}>초대 코드 생성</Text>
            </View>

            {inviteResult ? (
              <View
                style={[
                  styles.resultBox,
                  { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6", borderColor: cardBorder },
                ]}
              >
                <Text style={[styles.resultLabel, { color: colors.tabIconDefault }]}>
                  사용자 이름
                </Text>
                <Text style={[styles.resultValue, { color: colors.text }]}>
                  {inviteResult.display_name}
                </Text>
                <View style={styles.resultDivider} />
                <Text style={[styles.resultLabel, { color: colors.tabIconDefault }]}>
                  초대 코드
                </Text>
                <View style={styles.resultCodeRow}>
                  <Text selectable style={[styles.resultCode, { color: colors.text }]}>
                    {inviteResult.invite_code}
                  </Text>
                  <TouchableOpacity
                    style={[styles.copyBtn, { backgroundColor: colors.tint }]}
                    onPress={() => {
                      Clipboard.setString(inviteResult.invite_code);
                      showAlert("복사됨", "초대 코드가 복사되었습니다.");
                    }}
                  >
                    <MaterialCommunityIcons name="content-copy" size={14} color="#fff" />
                    <Text style={styles.copyBtnText}>복사</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <>
                <View style={styles.modalField}>
                  <Text style={[styles.modalFieldLabel, { color: colors.tabIconDefault }]}>
                    사용자 이름
                  </Text>
                  <TextInput
                    style={[
                      styles.modalInput,
                      {
                        color: colors.text,
                        backgroundColor: isDark ? "#2A2D31" : "#F9FAFB",
                        borderColor: cardBorder,
                      },
                    ]}
                    placeholder="이름을 입력하세요"
                    value={displayName}
                    onChangeText={setDisplayName}
                    autoFocus
                    placeholderTextColor={colors.tabIconDefault}
                  />
                </View>
                <View style={styles.modalField}>
                  <Text style={[styles.modalFieldLabel, { color: colors.tabIconDefault }]}>
                    역할
                  </Text>
                  <View style={styles.roleSelector}>
                    {(["member", "guest"] as const).map((r) => {
                      const selected = inviteRole === r;
                      const label = r === "member" ? "멤버" : "게스트";
                      return (
                        <TouchableOpacity
                          key={r}
                          style={[
                            styles.roleOption,
                            {
                              borderColor: selected ? colors.tint : cardBorder,
                              backgroundColor: selected
                                ? isDark
                                  ? "rgba(10,126,164,0.15)"
                                  : "#EFF8FC"
                                : isDark
                                  ? "#2A2D31"
                                  : "#F9FAFB",
                            },
                          ]}
                          onPress={() => setInviteRole(r)}
                        >
                          <MaterialCommunityIcons
                            name={r === "member" ? "account" : "account-outline"}
                            size={16}
                            color={selected ? colors.tint : colors.tabIconDefault}
                          />
                          <Text
                            style={[
                              styles.roleOptionText,
                              { color: selected ? colors.tint : colors.tabIconDefault },
                            ]}
                          >
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                </View>
              </>
            )}

            <View style={styles.modalFooter}>
              {inviteResult ? (
                <TouchableOpacity
                  style={[styles.modalBtnPrimary, { backgroundColor: "#3B82F6" }]}
                  onPress={handleCancel}
                >
                  <Text style={styles.modalBtnPrimaryText}>닫기</Text>
                </TouchableOpacity>
              ) : (
                <>
                  <TouchableOpacity
                    style={[
                      styles.modalBtnSecondary,
                      { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6" },
                    ]}
                    onPress={handleCancel}
                  >
                    <Text style={[styles.modalBtnSecondaryText, { color: colors.tabIconDefault }]}>
                      취소
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.modalBtnPrimary, { backgroundColor: "#3B82F6" }]}
                    onPress={handleOk}
                  >
                    <Text style={styles.modalBtnPrimaryText}>확인</Text>
                  </TouchableOpacity>
                </>
              )}
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 초대 코드 기록 모달 */}
      <Modal
        visible={isLogModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setIsLogModalOpen(false)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setIsLogModalOpen(false)}>
          <Pressable style={[styles.modalBox, { backgroundColor: modalBg }]}>
            <View style={styles.modalHeader}>
              <MaterialCommunityIcons name="ticket-outline" size={22} color={colors.tint} />
              <Text style={[styles.modalTitle, { color: colors.text }]}>초대 코드 목록</Text>
            </View>

            <ScrollView
              style={{ maxHeight: 320 }}
              contentContainerStyle={{ gap: 8 }}
              showsVerticalScrollIndicator={false}
            >
              {isLogLoading ? (
                <ActivityIndicator color={colors.tint} style={{ marginVertical: 24 }} />
              ) : inviteCodes.length === 0 ? (
                <Text style={[styles.logEmpty, { color: colors.tabIconDefault }]}>
                  발급된 코드가 없습니다
                </Text>
              ) : (
                inviteCodes.map((item) => {
                  const badge = item.expired_at
                    ? getExpiredBadgeStyle(item.expired_at, isDark)
                    : null;
                  return (
                    <View
                      key={item.invite_code}
                      style={[
                        styles.codeItem,
                        { backgroundColor: cardBg, borderColor: cardBorder },
                      ]}
                    >
                      <View style={styles.codeItemHeader}>
                        <Text style={[styles.codeName, { color: colors.text }]}>
                          {item.display_name}
                        </Text>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                          {item.role &&
                            (() => {
                              const role = getRoleStyle(item.role, isDark);
                              return (
                                <View style={[styles.rolePill, { backgroundColor: role.bg }]}>
                                  <MaterialCommunityIcons
                                    name={role.icon}
                                    size={11}
                                    color={role.color}
                                  />
                                  <Text
                                    style={[
                                      styles.rolePillText,
                                      { color: role.color, fontSize: 11 },
                                    ]}
                                  >
                                    {role.label}
                                  </Text>
                                </View>
                              );
                            })()}
                          <TouchableOpacity
                            onPress={() => handleDelete(item.invite_code)}
                            style={styles.codeDeleteBtn}
                          >
                            <MaterialCommunityIcons
                              name="trash-can-outline"
                              size={16}
                              color="#DC2626"
                            />
                          </TouchableOpacity>
                        </View>
                      </View>
                      <View
                        style={[
                          styles.codeRow,
                          { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6" },
                        ]}
                      >
                        <Text
                          style={[styles.codeValue, { color: colors.tabIconDefault }]}
                          numberOfLines={1}
                        >
                          {item.invite_code}
                        </Text>
                        <TouchableOpacity
                          onPress={() => {
                            Clipboard.setString(item.invite_code);
                            showAlert("복사됨", "초대 코드가 복사되었습니다.");
                          }}
                        >
                          <MaterialCommunityIcons
                            name="content-copy"
                            size={13}
                            color={colors.tabIconDefault}
                          />
                        </TouchableOpacity>
                      </View>
                      <View style={styles.codeItemFooter}>
                        {item.created_at && (
                          <Text style={[styles.codeDate, { color: colors.tabIconDefault }]}>
                            {new Date(item.created_at).toLocaleDateString()}
                          </Text>
                        )}
                        {badge && (
                          <View style={[styles.codeExpiredBadge, { backgroundColor: badge.bg }]}>
                            <Text style={[styles.codeExpiredText, { color: badge.color }]}>
                              {getTimeLeft(item.expired_at!)}
                            </Text>
                          </View>
                        )}
                      </View>
                    </View>
                  );
                })
              )}
            </ScrollView>

            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[styles.modalBtnPrimary, { backgroundColor: "#3B82F6" }]}
                onPress={() => setIsLogModalOpen(false)}
              >
                <Text style={styles.modalBtnPrimaryText}>닫기</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 별명 설정 모달 */}
      <Modal
        visible={isNicknameModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setIsNicknameModalOpen(false);
          setNicknameInput("");
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setIsNicknameModalOpen(false);
            setNicknameInput("");
          }}
        >
          <Pressable style={[styles.modalBox, { backgroundColor: modalBg }]}>
            <View style={styles.modalHeader}>
              <MaterialCommunityIcons name="pencil-outline" size={22} color={colors.tint} />
              <Text style={[styles.modalTitle, { color: colors.text }]}>기기 별명 설정</Text>
            </View>
            <View style={styles.modalField}>
              <Text style={[styles.modalFieldLabel, { color: colors.tabIconDefault }]}>별명</Text>
              <TextInput
                style={[
                  styles.modalInput,
                  {
                    color: colors.text,
                    backgroundColor: isDark ? "#2A2D31" : "#F9FAFB",
                    borderColor: cardBorder,
                  },
                ]}
                placeholder="별명을 입력하세요"
                value={nicknameInput}
                onChangeText={setNicknameInput}
                autoFocus
                placeholderTextColor={colors.tabIconDefault}
                maxLength={30}
              />
            </View>
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[
                  styles.modalBtnSecondary,
                  { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6" },
                ]}
                onPress={() => {
                  setIsNicknameModalOpen(false);
                  setNicknameInput("");
                }}
              >
                <Text style={[styles.modalBtnSecondaryText, { color: colors.tabIconDefault }]}>
                  취소
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalBtnPrimary,
                  { backgroundColor: nicknameInput.trim() ? "#3B82F6" : "#9CA3AF" },
                ]}
                disabled={!nicknameInput.trim()}
                onPress={handleNicknameConfirm}
              >
                <Text style={styles.modalBtnPrimaryText}>확인</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* 기기 삭제 모달 */}
      <Modal
        visible={deleteVisible}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setDeleteVisible(false);
          setConfirmInput("");
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setDeleteVisible(false);
            setConfirmInput("");
          }}
        >
          <Pressable style={[styles.modalBox, { backgroundColor: modalBg }]}>
            <View style={styles.modalHeader}>
              <MaterialCommunityIcons
                name={device.role === "master" ? "delete-outline" : "logout-variant"}
                size={22}
                color="#EF4444"
              />
              <Text style={[styles.modalTitle, { color: colors.text }]}>
                {device.role === "master" ? "기기 삭제" : "기기 탈퇴"}
              </Text>
            </View>
            <Text style={[styles.deleteGuide, { color: colors.tabIconDefault }]}>
              확인을 위해 기기 ID 앞 8자리를 입력해 주세요
            </Text>
            <Text style={[styles.deleteHint, { color: colors.text }]}>
              {device.device_uuid.slice(0, 8)}
            </Text>
            <TextInput
              style={[
                styles.modalInput,
                {
                  color: colors.text,
                  backgroundColor: isDark ? "#2A2D31" : "#F9FAFB",
                  borderColor: cardBorder,
                },
              ]}
              value={confirmInput}
              onChangeText={setConfirmInput}
              placeholder="앞 8자리 입력"
              placeholderTextColor={colors.tabIconDefault}
              maxLength={8}
              autoCapitalize="none"
            />
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[
                  styles.modalBtnSecondary,
                  { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6" },
                ]}
                onPress={() => {
                  setDeleteVisible(false);
                  setConfirmInput("");
                }}
              >
                <Text style={[styles.modalBtnSecondaryText, { color: colors.tabIconDefault }]}>
                  취소
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalBtnPrimary,
                  {
                    backgroundColor:
                      confirmInput === device.device_uuid.slice(0, 8) ? "#EF4444" : "#9CA3AF",
                  },
                ]}
                disabled={confirmInput !== device.device_uuid.slice(0, 8) || isDeleting}
                onPress={async () => {
                  setIsDeleting(true);
                  const result =
                    device.role === "master"
                      ? await deleteDevice(device.device_uuid)
                      : await deleteMemberShip(device.device_uuid);
                  setIsDeleting(false);
                  if (result?.type === "success") {
                    setDeleteVisible(false);
                    router.push("/home");
                  } else {
                    showAlert("삭제 실패", result?.message ?? "오류가 발생했습니다.");
                  }
                }}
              >
                {isDeleting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.modalBtnPrimaryText}>삭제</Text>
                )}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      {/* 게스트 토큰 발급 모달 */}
      <Modal
        visible={!!guestTokenTarget}
        transparent
        animationType="fade"
        onRequestClose={handleGuestTokenClose}
      >
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <Pressable style={styles.modalBackdrop} onPress={handleGuestTokenClose}>
            <Pressable style={[styles.modalBox, { backgroundColor: modalBg }]}>
              <View style={styles.modalHeader}>
                <MaterialCommunityIcons name="key-outline" size={22} color="#3B82F6" />
                <Text style={[styles.modalTitle, { color: colors.text }]}>게스트 토큰 발급</Text>
              </View>

              <Text style={[styles.modalDesc, { color: colors.tabIconDefault }]}>
                <Text style={{ fontWeight: "700", color: colors.text }}>
                  {guestTokenTarget?.display_name}
                </Text>
                {"에게 발급할 토큰 설정을 입력하세요."}
              </Text>
              <View style={styles.modalField}>
                <Text style={[styles.modalFieldLabel, { color: colors.tabIconDefault }]}>
                  최대 사용 횟수 (기본 1)
                </Text>
                <View style={styles.stepperRow}>
                  <TouchableOpacity
                    style={[
                      styles.stepperBtn,
                      { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6", borderColor: cardBorder },
                    ]}
                    onPress={() => setGuestTokenMaxUses((v) => Math.max(1, v - 1))}
                  >
                    <Text style={[styles.stepperBtnText, { color: colors.text }]}>−</Text>
                  </TouchableOpacity>
                  <Text
                    style={[
                      styles.stepperValue,
                      {
                        color: colors.text,
                        borderColor: cardBorder,
                        backgroundColor: isDark ? "#2A2D31" : "#F9FAFB",
                      },
                    ]}
                  >
                    {guestTokenMaxUses}
                  </Text>
                  <TouchableOpacity
                    style={[
                      styles.stepperBtn,
                      { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6", borderColor: cardBorder },
                    ]}
                    onPress={() => setGuestTokenMaxUses((v) => v + 1)}
                  >
                    <Text style={[styles.stepperBtnText, { color: colors.text }]}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>
              <View style={styles.modalField}>
                <Text style={[styles.modalFieldLabel, { color: colors.tabIconDefault }]}>
                  만료 시간 (기본 3일)
                </Text>
                <View style={styles.expireRow}>
                  <TextInput
                    style={[
                      styles.modalInput,
                      {
                        flex: 1,
                        color: colors.text,
                        backgroundColor: isDark ? "#2A2D31" : "#F9FAFB",
                        borderColor: cardBorder,
                      },
                    ]}
                    placeholder="3"
                    placeholderTextColor={colors.tabIconDefault}
                    value={guestTokenExpireValue}
                    onChangeText={setGuestTokenExpireValue}
                    keyboardType="numeric"
                  />
                  <View style={styles.unitSelector}>
                    {(["분", "시", "일"] as const).map((unit) => (
                      <TouchableOpacity
                        key={unit}
                        style={[
                          styles.unitBtn,
                          {
                            borderColor: guestTokenExpireUnit === unit ? "#3B82F6" : cardBorder,
                            backgroundColor:
                              guestTokenExpireUnit === unit
                                ? isDark
                                  ? "rgba(59,130,246,0.15)"
                                  : "#EFF6FF"
                                : isDark
                                  ? "#2A2D31"
                                  : "#F9FAFB",
                          },
                        ]}
                        onPress={() => setGuestTokenExpireUnit(unit)}
                      >
                        <Text
                          style={{
                            fontSize: 13,
                            fontWeight: "600",
                            color:
                              guestTokenExpireUnit === unit ? "#3B82F6" : colors.tabIconDefault,
                          }}
                        >
                          {unit}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
              </View>

              <TouchableOpacity
                style={styles.extraToggle}
                onPress={() => setGuestTokenShowExtra((v) => !v)}
              >
                <MaterialCommunityIcons
                  name={guestTokenShowExtra ? "chevron-up" : "chevron-down"}
                  size={16}
                  color={colors.tabIconDefault}
                />
                <Text style={[styles.extraToggleText, { color: colors.tabIconDefault }]}>
                  추가 옵션
                </Text>
              </TouchableOpacity>

              {guestTokenShowExtra && (
                <View style={styles.modalField}>
                  <Text style={[styles.modalFieldLabel, { color: colors.tabIconDefault }]}>
                    활성화 시작 시각 (기본 즉시)
                  </Text>
                  <TouchableOpacity
                    style={[
                      styles.datePickerBtn,
                      {
                        borderColor: guestTokenNotBeforeDate ? "#3B82F6" : cardBorder,
                        backgroundColor: isDark ? "#2A2D31" : "#F9FAFB",
                      },
                    ]}
                    onPress={() => setGuestTokenPickerStep("date")}
                  >
                    <MaterialCommunityIcons
                      name="calendar-clock-outline"
                      size={16}
                      color={guestTokenNotBeforeDate ? "#3B82F6" : colors.tabIconDefault}
                    />
                    <Text
                      style={{
                        flex: 1,
                        fontSize: 14,
                        color: guestTokenNotBeforeDate ? colors.text : colors.tabIconDefault,
                      }}
                    >
                      {guestTokenNotBeforeDate
                        ? `${guestTokenNotBeforeDate.toLocaleDateString()} ${guestTokenNotBeforeDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                        : "날짜/시간 선택"}
                    </Text>
                    {guestTokenNotBeforeDate && (
                      <TouchableOpacity onPress={() => setGuestTokenNotBeforeDate(null)}>
                        <MaterialCommunityIcons
                          name="close-circle-outline"
                          size={16}
                          color={colors.tabIconDefault}
                        />
                      </TouchableOpacity>
                    )}
                  </TouchableOpacity>
                  {guestTokenPickerStep !== null && (
                    <DateTimePicker
                      value={guestTokenNotBeforeDate ?? new Date()}
                      mode={guestTokenPickerStep === "date" ? "date" : "time"}
                      display={Platform.OS === "ios" ? "spinner" : "default"}
                      onValueChange={(_event, selected) => {
                        if (!selected) {
                          setGuestTokenPickerStep(null);
                          return;
                        }
                        if (guestTokenPickerStep === "date") {
                          const prev = guestTokenNotBeforeDate ?? new Date();
                          const next = new Date(selected);
                          next.setHours(prev.getHours(), prev.getMinutes(), 0, 0);
                          setGuestTokenNotBeforeDate(next);
                          if (Platform.OS === "android") setGuestTokenPickerStep("time");
                          else setGuestTokenPickerStep(null);
                        } else {
                          const prev = guestTokenNotBeforeDate ?? new Date();
                          const next = new Date(prev);
                          next.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
                          setGuestTokenNotBeforeDate(next);
                          setGuestTokenPickerStep(null);
                        }
                      }}
                      onDismiss={() => setGuestTokenPickerStep(null)}
                    />
                  )}
                </View>
              )}

              <View style={styles.modalFooter}>
                <TouchableOpacity
                  style={[
                    styles.modalBtnSecondary,
                    { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6" },
                  ]}
                  onPress={handleGuestTokenClose}
                >
                  <Text style={[styles.modalBtnSecondaryText, { color: colors.tabIconDefault }]}>
                    취소
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtnPrimary, { backgroundColor: "#3B82F6" }]}
                  onPress={handleGuestTokenConfirm}
                  disabled={guestTokenLoading}
                >
                  {guestTokenLoading ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.modalBtnPrimaryText}>발급</Text>
                  )}
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* 멤버 상세 바텀시트 */}
      <Modal
        visible={!!selectedMember}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedMember(null)}
      >
        <Pressable style={styles.bottomSheetBackdrop} onPress={() => setSelectedMember(null)}>
          <Pressable style={[styles.bottomSheet, { backgroundColor: modalBg }]}>
            <View style={[styles.bottomSheetHandle, { backgroundColor: cardBorder }]} />
            {selectedMember && (() => {
              const role = getRoleStyle(selectedMember.role, isDark);
              return (
                <>
                  <View style={styles.memberDetailInfo}>
                    <View style={[styles.memberDetailIconCircle, { backgroundColor: role.bg }]}>
                      <MaterialCommunityIcons name={role.icon} size={34} color={role.color} />
                    </View>
                    <Text style={[styles.memberDetailName, { color: colors.text }]}>
                      {selectedMember.display_name}
                    </Text>
                    <View style={[styles.rolePill, { backgroundColor: role.bg }]}>
                      <MaterialCommunityIcons name={role.icon} size={12} color={role.color} />
                      <Text style={[styles.rolePillText, { color: role.color }]}>{role.label}</Text>
                    </View>
                  </View>

                  <TouchableOpacity
                    style={[styles.memberDetailUuidRow, { backgroundColor: cardBg, borderColor: cardBorder }]}
                    onPress={() => {
                      Clipboard.setString(selectedMember.user_uuid);
                      showAlert("복사됨", "UUID가 복사되었습니다.");
                    }}
                  >
                    <Text style={[styles.memberDetailUuidLabel, { color: colors.tabIconDefault }]}>UUID</Text>
                    <Text style={[styles.memberDetailUuidValue, { color: colors.text }]} numberOfLines={1}>
                      {selectedMember.user_uuid}
                    </Text>
                    <MaterialCommunityIcons name="content-copy" size={14} color={colors.tabIconDefault} />
                  </TouchableOpacity>

                  {selectedMember.role === "guest" && (
                    <View style={styles.tokenSection}>
                      <Text style={[styles.tokenSectionTitle, { color: colors.text }]}>발급된 토큰</Text>
                      {selectedMemberTokensLoading ? (
                        <ActivityIndicator color={colors.tint} style={{ marginVertical: 8 }} />
                      ) : selectedMemberTokens.length === 0 ? (
                        <Text style={[styles.tokenEmpty, { color: colors.tabIconDefault }]}>발급된 토큰 없음</Text>
                      ) : (
                        <ScrollView style={{ maxHeight: 180 }} contentContainerStyle={{ gap: 6 }} showsVerticalScrollIndicator={false}>
                          {selectedMemberTokens.map((t, i) => {
                            const badge = t.expired_at ? getExpiredBadgeStyle(t.expired_at, isDark) : null;
                            return (
                              <View key={i} style={[styles.tokenItem, { backgroundColor: cardBg, borderColor: cardBorder }]}>
                                <View style={styles.tokenItemRow}>
                                  <MaterialCommunityIcons name="key-outline" size={14} color={colors.tabIconDefault} />
                                  <Text style={[styles.tokenItemText, { color: colors.text }]}>
                                    {`사용 ${t.use_count} / ${t.max_uses ?? "∞"}`}
                                  </Text>
                                  {badge && (
                                    <View style={[styles.codeExpiredBadge, { backgroundColor: badge.bg, marginLeft: "auto" }]}>
                                      <Text style={[styles.codeExpiredText, { color: badge.color }]}>
                                        {getTimeLeft(t.expired_at!)}
                                      </Text>
                                    </View>
                                  )}
                                  <TouchableOpacity
                                    onPress={() => {
                                      if (!device) return;
                                      showAlert("토큰 삭제", "이 토큰을 삭제하시겠습니까?", [
                                        { text: "취소", style: "cancel" },
                                        {
                                          text: "삭제",
                                          style: "destructive",
                                          onPress: async () => {
                                            const result = await deleteGuestToken(device.device_uuid, t.id);
                                            if (result.type === "success") {
                                              setSelectedMemberTokens((prev) => prev.filter((tk) => tk.id !== t.id));
                                            } else {
                                              showAlert("오류", result.message ?? "삭제에 실패했습니다.");
                                            }
                                          },
                                        },
                                      ]);
                                    }}
                                  >
                                    <MaterialCommunityIcons name="trash-can-outline" size={15} color="#DC2626" />
                                  </TouchableOpacity>
                                </View>
                                {t.not_before && (
                                  <Text style={[styles.tokenSubText, { color: colors.tabIconDefault }]}>
                                    {`활성화: ${new Date(t.not_before).toLocaleString()}`}
                                  </Text>
                                )}
                              </View>
                            );
                          })}
                        </ScrollView>
                      )}
                    </View>
                  )}

                  <View style={styles.memberDetailActions}>
                    {selectedMember.role === "guest" && (
                      <TouchableOpacity
                        style={[styles.memberDetailActionBtn, { backgroundColor: isDark ? "rgba(59,130,246,0.12)" : "#EFF6FF" }]}
                        onPress={() => {
                          setSelectedMember(null);
                          setGuestTokenTarget(selectedMember);
                        }}
                      >
                        <MaterialCommunityIcons name="key-outline" size={18} color="#3B82F6" />
                        <Text style={{ fontSize: 14, fontWeight: "600", color: "#3B82F6" }}>게스트 토큰 발급</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      style={[styles.memberDetailActionBtn, { backgroundColor: isDark ? "rgba(239,68,68,0.12)" : "#FEF2F2" }]}
                      onPress={() => {
                        setSelectedMember(null);
                        handleDeleteMember(selectedMember);
                      }}
                    >
                      <MaterialCommunityIcons name="account-remove-outline" size={18} color="#EF4444" />
                      <Text style={{ fontSize: 14, fontWeight: "600", color: "#EF4444" }}>멤버 추방</Text>
                    </TouchableOpacity>
                  </View>
                </>
              );
            })()}
          </Pressable>
        </Pressable>
      </Modal>

      {/* 활동 로그 모달 */}
      <Modal
        visible={isActivityLogOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setIsActivityLogOpen(false)}
      >
        <Pressable style={styles.activityLogBackdrop} onPress={() => setIsActivityLogOpen(false)}>
          <Pressable style={[styles.activityLogSheet, { backgroundColor: modalBg }]} onPress={() => {}}>
            <View style={[styles.activityLogHeader, { borderBottomColor: cardBorder }]}>
              <Text style={[styles.activityLogTitle, { color: colors.text }]}>활동 로그</Text>
              <TouchableOpacity onPress={() => setIsActivityLogOpen(false)}>
                <MaterialCommunityIcons name="close" size={20} color={colors.tabIconDefault} />
              </TouchableOpacity>
            </View>

            <View style={styles.activityLogTabs}>
              {(["device", "access", "member"] as const).map((tab) => {
                const label = tab === "device" ? "기기" : tab === "access" ? "출입" : "멤버";
                const active = activityLogTab === tab;
                return (
                  <TouchableOpacity
                    key={tab}
                    style={[styles.activityLogTabBtn, active && styles.activityLogTabBtnActive]}
                    onPress={() => {
                      setActivityLogTab(tab);
                      if (device) loadActivityLogs(tab, device.device_uuid);
                    }}
                  >
                    <Text style={[styles.activityLogTabText, { color: active ? "#3B82F6" : colors.tabIconDefault }]}>
                      {label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {activityLogLoading ? (
              <View style={styles.activityLogCenter}>
                <ActivityIndicator color="#3B82F6" />
              </View>
            ) : activityLogError ? (
              <View style={styles.activityLogCenter}>
                <Text style={{ color: "#EF4444", fontSize: 13 }}>{activityLogError}</Text>
              </View>
            ) : (
              <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
                {activityLogs.map((log) => (
                  <View key={log.id} style={[styles.activityLogItem, { borderBottomColor: cardBorder }]}>
                    <View style={styles.activityLogItemRow}>
                      <Text style={[styles.activityLogAction, { color: colors.text }]}>
                        {getActionLabel(log.action)}
                      </Text>
                      <Text style={[styles.activityLogTime, { color: colors.tabIconDefault }]}>
                        {formatLogTime(log.created_at)}
                      </Text>
                    </View>
                    {(log.display_name || log.detail) && (
                      <Text style={[styles.activityLogSub, { color: colors.tabIconDefault }]} numberOfLines={2}>
                        {[log.display_name, log.detail].filter(Boolean).join(" · ")}
                      </Text>
                    )}
                  </View>
                ))}
                {activityLogs.length === 0 && (
                  <Text style={[styles.activityLogEmpty, { color: colors.tabIconDefault }]}>
                    로그가 없습니다.
                  </Text>
                )}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      <CustomAlert
        visible={!!alertConfig}
        title={alertConfig?.title ?? ""}
        message={alertConfig?.message}
        buttons={alertConfig?.buttons}
        onRequestClose={() => setAlertConfig(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
  },
  scrollContent: {
    padding: 16,
    gap: 20,
    paddingBottom: 40,
  },

  // 기기 카드
  deviceCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
    gap: 12,
  },
  deviceCardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  deviceCardDivider: {
    height: 1,
  },
  deviceCardBottom: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  deviceStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  deviceStatusText: {
    fontSize: 12,
  },
  deviceIconCircle: {
    width: 52,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  deviceIcon: {
    width: 32,
    height: 32,
  },
  devicePrimary: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  deviceUuid: {
    fontSize: 11,
    letterSpacing: -0.2,
  },
  rolePill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  rolePillText: {
    fontSize: 12,
    fontWeight: "600",
  },

  // 섹션
  section: {
    gap: 10,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: -0.2,
  },
  sectionActions: {
    flexDirection: "row",
    gap: 8,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: "600",
  },

  // 지도
  mapContainer: {
    height: 220,
    borderRadius: 14,
    borderWidth: 1,
    overflow: "hidden",
  },
  emptyMap: {
    height: 120,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  emptyMapText: {
    fontSize: 14,
  },

  // 멤버 목록
  memberList: {
    gap: 8,
  },
  memberCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
  },
  memberIconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  memberName: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
  },
  memberCardRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  memberDeleteBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyMembers: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 24,
    alignItems: "center",
  },
  emptyMembersText: {
    fontSize: 14,
  },

  // 모달 공통
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalBox: {
    width: "100%",
    borderRadius: 20,
    padding: 24,
    gap: 20,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  modalField: {
    gap: 6,
  },
  modalDesc: {
    fontSize: 13,
    lineHeight: 19,
  },
  modalFieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    marginLeft: 2,
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  resultBox: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 4,
  },
  resultLabel: {
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  resultValue: {
    fontSize: 15,
    fontWeight: "600",
  },
  resultDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: "#e5e7eb",
    marginVertical: 8,
  },
  resultCodeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  resultCode: {
    flex: 1,
    fontSize: 14,
    fontFamily: "monospace",
    letterSpacing: 0.5,
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
  },
  copyBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#fff",
  },
  modalFooter: {
    flexDirection: "row",
    gap: 10,
  },
  modalBtnPrimary: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
  },
  modalBtnPrimaryText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },
  modalBtnSecondary: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
  },
  modalBtnSecondaryText: {
    fontSize: 15,
    fontWeight: "600",
  },

  // 코드 목록
  logEmpty: {
    textAlign: "center",
    marginVertical: 24,
    fontSize: 14,
  },
  codeItem: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 8,
  },
  codeItemHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  codeItemFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  codeName: {
    fontSize: 14,
    fontWeight: "600",
  },
  codeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  codeValue: {
    flex: 1,
    fontSize: 11,
    fontFamily: "monospace",
  },
  codeDate: {
    fontSize: 11,
  },
  codeDeleteBtn: {
    padding: 4,
  },
  codeExpiredBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  codeExpiredText: {
    fontSize: 11,
    fontWeight: "600",
  },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#FEE2E2",
    borderRadius: 8,
  },
  deleteBtnText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#DC2626",
  },
  topBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  deleteIconBtn: {
    padding: 4,
  },
  cardActions: {
    flexDirection: "row",
    gap: 6,
  },
  cardActionBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  pingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  deleteGuide: {
    fontSize: 14,
    lineHeight: 20,
  },
  deleteHint: {
    fontSize: 15,
    fontWeight: "700",
    fontFamily: "monospace",
    letterSpacing: 1,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  stepperBtn: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperBtnText: {
    fontSize: 20,
    lineHeight: 24,
    fontWeight: "400",
  },
  stepperValue: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "600",
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 8,
  },
  extraToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  extraToggleText: {
    fontSize: 13,
    fontWeight: "600",
  },
  expireRow: {
    flexDirection: "row",
    gap: 8,
    alignItems: "center",
  },
  unitSelector: {
    flexDirection: "row",
    gap: 6,
  },
  unitBtn: {
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  roleSelector: {
    flexDirection: "row",
    gap: 10,
  },
  roleOption: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 11,
    borderRadius: 12,
    borderWidth: 1,
  },
  roleOptionText: {
    fontSize: 14,
    fontWeight: "600",
  },
  datePickerBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  bottomSheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  bottomSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    paddingBottom: 40,
    gap: 16,
  },
  bottomSheetHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 4,
  },
  memberDetailInfo: {
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
  memberDetailIconCircle: {
    width: 68,
    height: 68,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  memberDetailName: {
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  memberDetailUuidRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  memberDetailUuidLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  memberDetailUuidValue: {
    flex: 1,
    fontSize: 12,
    fontFamily: "monospace",
  },
  memberDetailActions: {
    gap: 8,
  },
  memberDetailActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderRadius: 14,
  },
  tokenSection: {
    gap: 8,
  },
  tokenSectionTitle: {
    fontSize: 13,
    fontWeight: "700",
  },
  tokenEmpty: {
    fontSize: 13,
    textAlign: "center",
    paddingVertical: 8,
  },
  tokenItem: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 10,
    gap: 4,
  },
  tokenItemRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  tokenItemText: {
    fontSize: 13,
    fontWeight: "600",
  },
  tokenSubText: {
    fontSize: 11,
    marginLeft: 20,
  },

  // 활동 로그 모달
  activityLogBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  activityLogSheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    height: "70%",
  },
  activityLogHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  activityLogTitle: {
    fontSize: 16,
    fontWeight: "700",
  },
  activityLogTabs: {
    flexDirection: "row",
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 8,
  },
  activityLogTabBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "transparent",
  },
  activityLogTabBtnActive: {
    borderColor: "#3B82F6",
    backgroundColor: "rgba(59,130,246,0.08)",
  },
  activityLogTabText: {
    fontSize: 13,
    fontWeight: "600",
  },
  activityLogCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
  },
  activityLogItem: {
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 3,
  },
  activityLogItemRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  activityLogAction: {
    fontSize: 14,
    fontWeight: "600",
  },
  activityLogTime: {
    fontSize: 11,
  },
  activityLogSub: {
    fontSize: 12,
  },
  activityLogEmpty: {
    textAlign: "center",
    fontSize: 13,
    paddingVertical: 32,
  },
});
