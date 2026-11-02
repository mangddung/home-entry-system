// 기기 설정. 가끔만 쓰는 항목을 상세 화면에서 분리해 모은다.
// 역할에 맞는 항목만 보여주고, 실제 권한은 서버가 다시 확인한다.
import { CustomAlert } from "@/components/custom-alert";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { deleteDevice, deleteMemberShip, fetchDevices, loadDevices, updateDeviceName } from "@/lib/api/devices";
import { fetchGuestTokens } from "@/lib/api/members";
import { unbondDevice } from "@/lib/bond";
import { USER_UUID_KEY } from "@/lib/constants";
import { getTokenSecure } from "@/lib/token-storage";
import type { IoTDevice } from "@/lib/types";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import type { ComponentProps } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
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

type MyToken = { is_active: boolean; max_uses: number | null; use_count: number };

const leaveWarning = (tokens: MyToken[]) => {
  const consequence = "탈퇴하면 토큰과 기기 접근 권한이 삭제되며 다시 초대받아야 합니다.";
  if (tokens.some((t) => t.max_uses == null && t.is_active)) {
    return `아직 사용 가능한 토큰이 남아 있습니다. ${consequence}`;
  }
  const remaining = tokens.reduce((sum, t) => sum + Math.max(0, (t.max_uses ?? 0) - t.use_count), 0);
  return remaining > 0
    ? `아직 ${remaining}회 사용 가능한 토큰이 남아 있습니다. ${consequence}`
    : "탈퇴하면 기기 접근 권한이 삭제되며 다시 초대받아야 합니다.";
};

export default function DeviceSettingScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const cardBorder = isDark ? "#2C3237" : "#E2E8F0";
  const inputBg = isDark ? "#2A2D31" : "#F9FAFB";
  const secondaryBg = isDark ? "#2A2D31" : "#F3F4F6";
  const modalBg = isDark ? "#1E2124" : "#FFFFFF";
  const rowColors = {
    text: colors.text,
    sub: colors.tabIconDefault,
    bg: isDark ? "#1E2124" : "#F8FAFC",
    border: cardBorder,
  };
  const { device_uuid } = useLocalSearchParams<{ device_uuid?: string }>();

  const [device, setDevice] = useState<IoTDevice | null | undefined>(undefined); // undefined = 로딩 중
  const [myTokens, setMyTokens] = useState<MyToken[]>([]);
  const [isNicknameOpen, setIsNicknameOpen] = useState(false);
  const [nicknameInput, setNicknameInput] = useState("");
  const [isRemoveOpen, setIsRemoveOpen] = useState(false);
  const [confirmInput, setConfirmInput] = useState("");
  const [leaveCountdown, setLeaveCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [alertConfig, setAlertConfig] = useState<{ title: string; message: string } | null>(null);

  // 보정 화면에서 돌아오면 바뀐 기준값을 다시 보여준다
  useFocusEffect(
    useCallback(() => {
      void (async () => {
        const found = (await loadDevices()).find((d) => d.device_uuid === device_uuid) ?? null;
        setDevice(found);
        if (!found || found.role === "master") return;
        const uuid = await getTokenSecure(USER_UUID_KEY);
        if (!uuid) return;
        // 탈퇴 경고에 남은 토큰을 보여주기 위해 미리 읽는다
        const result = await fetchGuestTokens(found.device_uuid, uuid);
        if (result.type === "success") setMyTokens(result.data as MyToken[]);
      })();
    }, [device_uuid]),
  );

  const isMaster = device?.role === "master";

  // 탈퇴는 실수 방지를 위해 2초 뒤에 버튼이 활성화된다
  useEffect(() => {
    if (!isRemoveOpen || isMaster) return;
    setLeaveCountdown(2);
    const timer = setInterval(() => {
      setLeaveCountdown((v) => {
        if (v <= 1) {
          clearInterval(timer);
          return 0;
        }
        return v - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isRemoveOpen, isMaster]);

  const closeNickname = () => {
    setIsNicknameOpen(false);
    setNicknameInput("");
  };

  const closeRemove = () => {
    setIsRemoveOpen(false);
    setConfirmInput("");
  };

  const saveNickname = async () => {
    const nickname = nicknameInput.trim();
    if (!device || !nickname) return;
    setBusy(true);
    const result = await updateDeviceName(device.device_uuid, nickname);
    if (result.type === "success") {
      setDevice({ ...device, device_nickname: nickname });
      // 상세·홈 화면이 캐시를 읽으므로 돌아가기 전에 갱신한다
      await fetchDevices();
      closeNickname();
    } else {
      setAlertConfig({ title: "오류", message: result.message ?? "오류가 발생했습니다." });
    }
    setBusy(false);
  };

  const remove = async () => {
    if (!device) return;
    setBusy(true);
    const result = isMaster ? await deleteDevice(device.device_uuid) : await deleteMemberShip(device.device_uuid);
    if (result?.type === "success") {
      await unbondDevice(device.device_uuid);
      // 상세 화면까지 함께 닫아 지워진 기기로 돌아가지 않게 한다
      router.dismissTo("/home");
      return;
    }
    setBusy(false);
    setAlertConfig({ title: isMaster ? "삭제 실패" : "탈퇴 실패", message: result?.message ?? "오류가 발생했습니다." });
  };

  const params = { device_uuid: device_uuid ?? "" };
  const canRemove = !!device && (isMaster ? confirmInput === device.device_uuid.slice(0, 8) : leaveCountdown === 0);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.titleBar, { borderBottomColor: isDark ? "#2a2d2e" : "#e5e7eb" }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={[styles.backText, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.titleText, { color: colors.text }]}>기기 설정</Text>
      </View>

      {device === undefined ? (
        <ActivityIndicator style={{ marginTop: 32 }} size="large" color={colors.tint} />
      ) : !device ? (
        <View style={styles.body}>
          <Text style={[styles.hint, { color: colors.tabIconDefault }]}>기기를 찾을 수 없습니다.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <SettingRow
            icon="pencil-outline"
            iconColor={colors.tabIconDefault}
            title="기기 별명"
            sub={device.device_nickname || "미설정"}
            colors={rowColors}
            onPress={() => {
              setNicknameInput(device.device_nickname ?? "");
              setIsNicknameOpen(true);
            }}
          />
          {/* 게스트는 수동 인증 전용이라 근접 해제가 없다 */}
          {device.role !== "guest" && (
            <SettingRow
              icon="signal-distance-variant"
              iconColor="#16a34a"
              title="열림 거리 보정"
              sub={`기기 기준 ${device.rssi_threshold != null ? `${device.rssi_threshold} dBm` : "미설정 (발견 즉시 열림)"}`}
              colors={rowColors}
              onPress={() => router.push({ pathname: "/device/rssi-calibrate", params })}
            />
          )}
          {isMaster && (
            <SettingRow
              icon="tune-variant"
              iconColor={colors.tint}
              title="서보 동작 범위"
              sub="동작 각도와 대기 각도를 조정합니다"
              colors={rowColors}
              onPress={() => router.push({ pathname: "/device/servo-range", params })}
            />
          )}

          <TouchableOpacity
            style={[styles.row, styles.removeRow, { backgroundColor: rowColors.bg, borderColor: cardBorder }]}
            onPress={() => setIsRemoveOpen(true)}
          >
            <MaterialCommunityIcons name={isMaster ? "delete-outline" : "logout-variant"} size={20} color="#EF4444" />
            <Text style={[styles.rowTitle, styles.removeText]}>{isMaster ? "기기 삭제" : "그룹 나가기"}</Text>
          </TouchableOpacity>
        </ScrollView>
      )}

      {/* 별명 설정 모달 */}
      <Modal visible={isNicknameOpen} transparent animationType="fade" onRequestClose={closeNickname}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <Pressable style={styles.modalBackdrop} onPress={closeNickname}>
            <Pressable style={[styles.modalBox, { backgroundColor: modalBg }]}>
              <View style={styles.modalHeader}>
                <MaterialCommunityIcons name="pencil-outline" size={22} color={colors.tint} />
                <Text style={[styles.modalTitle, { color: colors.text }]}>기기 별명 설정</Text>
              </View>
              <View style={styles.modalField}>
                <Text style={[styles.modalFieldLabel, { color: colors.tabIconDefault }]}>별명</Text>
                <TextInput
                  style={[styles.modalInput, { color: colors.text, backgroundColor: inputBg, borderColor: cardBorder }]}
                  placeholder="별명을 입력하세요"
                  value={nicknameInput}
                  onChangeText={setNicknameInput}
                  autoFocus
                  placeholderTextColor={colors.tabIconDefault}
                  maxLength={30}
                />
              </View>
              <View style={styles.modalFooter}>
                <TouchableOpacity style={[styles.modalBtn, { backgroundColor: secondaryBg }]} onPress={closeNickname}>
                  <Text style={[styles.modalBtnSecondaryText, { color: colors.tabIconDefault }]}>취소</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, { backgroundColor: nicknameInput.trim() ? "#3B82F6" : "#9CA3AF" }]}
                  disabled={!nicknameInput.trim() || busy}
                  onPress={saveNickname}
                >
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalBtnPrimaryText}>확인</Text>}
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      {/* 삭제·탈퇴 모달 */}
      <Modal visible={isRemoveOpen} transparent animationType="fade" onRequestClose={closeRemove}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
          <Pressable style={styles.modalBackdrop} onPress={closeRemove}>
            <Pressable style={[styles.modalBox, { backgroundColor: modalBg }]}>
              <View style={styles.modalHeader}>
                <MaterialCommunityIcons name={isMaster ? "delete-outline" : "logout-variant"} size={22} color="#EF4444" />
                <Text style={[styles.modalTitle, { color: colors.text }]}>{isMaster ? "기기 삭제" : "그룹 나가기"}</Text>
              </View>
              {isMaster && device ? (
                <>
                  <Text style={[styles.removeGuide, { color: colors.tabIconDefault }]}>
                    확인을 위해 기기 ID 앞 8자리를 입력해 주세요
                  </Text>
                  <Text style={[styles.removeHint, { color: colors.text }]}>{device.device_uuid.slice(0, 8)}</Text>
                  <TextInput
                    style={[styles.modalInput, { color: colors.text, backgroundColor: inputBg, borderColor: cardBorder }]}
                    value={confirmInput}
                    onChangeText={setConfirmInput}
                    placeholder="앞 8자리 입력"
                    placeholderTextColor={colors.tabIconDefault}
                    maxLength={8}
                    autoCapitalize="none"
                  />
                </>
              ) : (
                <Text style={[styles.removeGuide, { color: colors.tabIconDefault }]}>{leaveWarning(myTokens)}</Text>
              )}
              <View style={styles.modalFooter}>
                <TouchableOpacity style={[styles.modalBtn, { backgroundColor: secondaryBg }]} onPress={closeRemove}>
                  <Text style={[styles.modalBtnSecondaryText, { color: colors.tabIconDefault }]}>취소</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalBtn, { backgroundColor: canRemove ? "#EF4444" : "#9CA3AF" }]}
                  disabled={!canRemove || busy}
                  onPress={remove}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.modalBtnPrimaryText}>
                      {isMaster ? "삭제" : leaveCountdown > 0 ? `나가기 (${leaveCountdown})` : "나가기"}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </Pressable>
          </Pressable>
        </KeyboardAvoidingView>
      </Modal>

      <CustomAlert
        visible={!!alertConfig}
        title={alertConfig?.title ?? ""}
        message={alertConfig?.message}
        onRequestClose={() => setAlertConfig(null)}
      />
    </SafeAreaView>
  );
}

function SettingRow({
  icon,
  iconColor,
  title,
  sub,
  colors,
  onPress,
}: {
  icon: ComponentProps<typeof MaterialCommunityIcons>["name"];
  iconColor: string;
  title: string;
  sub: string;
  colors: { text: string; sub: string; bg: string; border: string };
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: colors.bg, borderColor: colors.border }]}
      onPress={onPress}
    >
      <MaterialCommunityIcons name={icon} size={20} color={iconColor} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[styles.rowTitle, { color: colors.text }]}>{title}</Text>
        <Text style={[styles.rowSub, { color: colors.sub }]} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <MaterialCommunityIcons name="chevron-right" size={18} color={colors.sub} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  titleBar: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  backBtn: { paddingRight: 8 },
  backText: { fontSize: 28, lineHeight: 32 },
  titleText: { fontSize: 17, fontWeight: "700" },
  body: { padding: 24, gap: 10 },
  hint: { fontSize: 12, lineHeight: 18 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  rowTitle: { fontSize: 14, fontWeight: "600" },
  rowSub: { fontSize: 12 },
  removeRow: { marginTop: 22 },
  removeText: { color: "#EF4444" },
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
  modalHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  modalTitle: { fontSize: 17, fontWeight: "700" },
  modalField: { gap: 6 },
  modalFieldLabel: { fontSize: 13, fontWeight: "600", marginLeft: 2 },
  modalInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  modalFooter: { flexDirection: "row", gap: 10 },
  modalBtn: { flex: 1, paddingVertical: 13, borderRadius: 12, alignItems: "center" },
  modalBtnPrimaryText: { fontSize: 15, fontWeight: "700", color: "#fff" },
  modalBtnSecondaryText: { fontSize: 15, fontWeight: "600" },
  removeGuide: { fontSize: 14, lineHeight: 20 },
  removeHint: { fontSize: 15, fontWeight: "700", fontFamily: "monospace", letterSpacing: 1 },
});
