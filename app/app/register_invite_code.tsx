import { Colors } from "@/constants/theme";
import { CustomAlert } from "@/components/custom-alert";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { fetchInvitePreview, fetchRegisterInviteCode, type InvitePreview } from "@/lib/api/auth";
import { loadDevices, updateDeviceName } from "@/lib/api/devices";
import { extractInviteCode } from "@/lib/api/members";
import { MAX_DEVICES_PER_USER } from "@/lib/constants";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function RegisterInviteCodeScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const isDark = colorScheme === "dark";
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [alertConfig, setAlertConfig] = useState<{ title: string; message?: string; onClose?: () => void } | null>(null);

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [nicknameModalVisible, setNicknameModalVisible] = useState(false);
  const [registeredDeviceUuid, setRegisteredDeviceUuid] = useState<string | null>(null);
  const [registeredRole, setRegisteredRole] = useState<string | null>(null);
  // 멤버 가입 후 근접 해제 보정 권유 (게스트는 수동 전용이라 묻지 않음)
  const [calibratePrompt, setCalibratePrompt] = useState(false);
  const calibrateChosenRef = useRef(false); // CustomAlert는 버튼 후 onRequestClose도 부르므로 이동은 거기서 한 번만
  const [nickname, setNickname] = useState("");

  const showAlert = (title: string, message?: string, onClose?: () => void) =>
    setAlertConfig({ title, message, onClose });

  const handleSubmit = async (raw?: string) => {
    const code = extractInviteCode(raw ?? inviteCode);
    if (!code) {
      showAlert("오류", "초대 코드를 입력해주세요.");
      return;
    }
    setInviteCode(code);
    if ((await loadDevices()).length >= MAX_DEVICES_PER_USER) {
      showAlert("등록 제한", `기기는 최대 ${MAX_DEVICES_PER_USER}개까지 등록할 수 있습니다.`);
      return;
    }
    setLoading(true);
    const result = await fetchInvitePreview(code);
    setLoading(false);
    if (result.type === "success") {
      setPreview(result.data as InvitePreview);
    } else {
      showAlert("오류", result.message);
    }
  };

  const { code: linkedCode } = useLocalSearchParams<{ code?: string }>();
  useEffect(() => {
    if (linkedCode) handleSubmit(linkedCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedCode]);

  const handleAccept = async () => {
    setAccepting(true);
    const result = await fetchRegisterInviteCode(inviteCode.trim());
    setAccepting(false);
    if (result.type === "success") {
      setRegisteredRole(preview?.role ?? null);
      setPreview(null);
      if (result.device_uuid) {
        setRegisteredDeviceUuid(result.device_uuid);
        setNicknameModalVisible(true);
      } else {
        router.back();
      }
    } else {
      showAlert("오류", result.message);
    }
  };

  const formatDuration = (minutes: number) => {
    if (minutes % 1440 === 0) return `${minutes / 1440}일`;
    if (minutes % 60 === 0) return `${minutes / 60}시간`;
    return `${minutes}분`;
  };

  const handleNicknameConfirm = async () => {
    if (registeredDeviceUuid && nickname.trim()) {
      await updateDeviceName(registeredDeviceUuid, nickname.trim());
    }
    setNicknameModalVisible(false);
    if (registeredRole === "member" && registeredDeviceUuid) setCalibratePrompt(true);
    else router.back();
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.titleBar, { borderBottomColor: isDark ? "#2a2d2e" : "#e5e7eb" }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={[styles.backText, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.titleText, { color: colors.text }]}>초대 코드 가입</Text>
      </View>
      {preview ? (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={[styles.previewCard, { backgroundColor: isDark ? "#1E2124" : "#fff", borderColor: isDark ? "#2C3237" : "#E2E8F0" }]}>
            <View style={styles.modalHeader}>
              <MaterialCommunityIcons name="account-plus-outline" size={22} color={colors.tint} />
              <Text style={[styles.modalTitle, { color: colors.text }]}>초대 정보</Text>
            </View>

            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: colors.icon }]}>기기</Text>
              <Text style={[styles.previewValue, { color: colors.text }]} numberOfLines={1}>
                {preview.device_nickname ?? "-"}
              </Text>
            </View>
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: colors.icon }]}>기기 ID</Text>
              <Text style={[styles.previewValue, { color: colors.text }]}>{preview.device_uuid_prefix ?? "-"}</Text>
            </View>
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: colors.icon }]}>부여 역할</Text>
              <Text style={[styles.previewValue, { color: colors.text }]}>
                {preview.role === "guest" ? "게스트" : "멤버"}
              </Text>
            </View>
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: colors.icon }]}>초대한 사람</Text>
              <Text style={[styles.previewValue, { color: colors.text }]} numberOfLines={1}>
                {preview.inviter_name ?? "-"}
              </Text>
            </View>
            <View style={styles.previewRow}>
              <Text style={[styles.previewLabel, { color: colors.icon }]}>코드 만료</Text>
              <Text style={[styles.previewValue, { color: colors.text }]}>
                {preview.expired_at ? new Date(preview.expired_at).toLocaleString() : "-"}
              </Text>
            </View>

            {preview.role === "guest" && !!preview.token_expire_minutes && (
              <View style={[styles.tokenBox, { backgroundColor: isDark ? "#2A2D31" : "#F9FAFB", borderColor: isDark ? "#2C3237" : "#E2E8F0" }]}>
                <View style={styles.modalHeader}>
                  <MaterialCommunityIcons name="key-outline" size={18} color="#3B82F6" />
                  <Text style={[styles.tokenBoxTitle, { color: colors.text }]}>사전 발급 토큰</Text>
                </View>
                <Text style={[styles.modalDesc, { color: colors.icon }]}>
                  {`${preview.token_max_uses ?? 1}회 사용 가능 · 발급 후 ${formatDuration(preview.token_expire_minutes)} 유효`}
                </Text>
                {!!preview.token_not_before && (
                  <Text style={[styles.modalDesc, { color: colors.icon }]}>
                    {`활성화: ${new Date(preview.token_not_before).toLocaleString()}`}
                  </Text>
                )}
              </View>
            )}
          </View>

          <View style={styles.modalFooter}>
            <TouchableOpacity
              style={[styles.button, { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6", flex: 1 }]}
              onPress={() => setPreview(null)}
              disabled={accepting}
            >
              <Text style={[styles.buttonText, { color: colors.icon }]}>취소</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, { flex: 1 }, accepting && styles.buttonDisabled]}
              onPress={handleAccept}
              disabled={accepting}
            >
              {accepting ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>초대 수락</Text>}
            </TouchableOpacity>
          </View>
        </ScrollView>
      ) : (
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.body}>
          <TextInput
            style={[styles.input, { backgroundColor: colors.background, color: colors.text, borderColor: colors.icon }]}
            placeholder="초대 코드 입력"
            placeholderTextColor={colors.icon}
            value={inviteCode}
            onChangeText={setInviteCode}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TouchableOpacity
            style={[styles.button, loading && styles.buttonDisabled]}
            onPress={() => handleSubmit()}
            disabled={loading}
          >
            <Text style={styles.buttonText}>{loading ? "처리 중..." : "확인"}</Text>
          </TouchableOpacity>
        </KeyboardAvoidingView>
      )}
      <CustomAlert
        visible={!!alertConfig}
        title={alertConfig?.title ?? ""}
        message={alertConfig?.message}
        buttons={[{ text: "확인", onPress: alertConfig?.onClose }]}
        onRequestClose={() => setAlertConfig(null)}
      />

      {/* 별명 설정 모달 */}
      <Modal visible={nicknameModalVisible} transparent animationType="fade" onRequestClose={handleNicknameConfirm}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <Pressable style={styles.modalBackdrop} onPress={() => {}}>
          <View style={[styles.modalBox, { backgroundColor: isDark ? "#1E2124" : "#fff" }]}>
            <View style={styles.modalHeader}>
              <MaterialCommunityIcons name="pencil-outline" size={22} color={colors.tint} />
              <Text style={[styles.modalTitle, { color: colors.text }]}>기기 별명 설정</Text>
            </View>
            <Text style={[styles.modalDesc, { color: colors.icon }]}>
              가입한 기기에 별명을 설정할 수 있어요. 건너뛰려면 나중에를 탭하세요.
            </Text>
            <TextInput
              style={[styles.input, { backgroundColor: isDark ? "#2A2D31" : "#F9FAFB", color: colors.text, borderColor: isDark ? "#2C3237" : "#E2E8F0" }]}
              placeholder="별명을 입력하세요"
              placeholderTextColor={colors.icon}
              value={nickname}
              onChangeText={setNickname}
              autoFocus
              maxLength={30}
            />
            <View style={styles.modalFooter}>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: isDark ? "#2A2D31" : "#F3F4F6", flex: 1 }]}
                onPress={handleNicknameConfirm}
              >
                <Text style={[styles.buttonText, { color: colors.icon }]}>나중에</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, { backgroundColor: nickname.trim() ? "#3B82F6" : "#9CA3AF", flex: 1 }]}
                disabled={!nickname.trim()}
                onPress={handleNicknameConfirm}
              >
                <Text style={styles.buttonText}>저장</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Pressable>
        </KeyboardAvoidingView>
      </Modal>
      <CustomAlert
        visible={calibratePrompt}
        title="열림 거리를 보정하시겠습니까?"
        message="문 앞에서 폰을 주머니에 넣고 약 10초 측정하면, 문 앞에 도착할 때 맞춰 열리도록 조절합니다. 나중에 기기 상세에서도 할 수 있습니다."
        buttons={[
          { text: "나중에", style: "cancel" },
          { text: "보정하기", onPress: () => { calibrateChosenRef.current = true; } },
        ]}
        onRequestClose={() => {
          setCalibratePrompt(false);
          if (calibrateChosenRef.current && registeredDeviceUuid) {
            router.replace({ pathname: "/device/rssi-calibrate", params: { device_uuid: registeredDeviceUuid, from: "setup" } });
          } else {
            router.back();
          }
        }}
      />
    </SafeAreaView>
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
  body: {
    padding: 24,
    gap: 16,
  },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  button: {
    backgroundColor: "#3b82f6",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: "#fff", fontSize: 15, fontWeight: "600" },
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
    gap: 16,
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
  modalDesc: {
    fontSize: 13,
    lineHeight: 19,
  },
  previewCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
    gap: 12,
  },
  previewRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  previewLabel: { fontSize: 13, width: 78 },
  previewValue: { fontSize: 14, fontWeight: "600", flex: 1, textAlign: "right" },
  tokenBox: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    gap: 6,
  },
  tokenBoxTitle: { fontSize: 14, fontWeight: "700" },
  modalFooter: {
    flexDirection: "row",
    gap: 10,
  },
});
