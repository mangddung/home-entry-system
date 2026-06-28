import { Colors } from "@/constants/theme";
import { CustomAlert } from "@/components/custom-alert";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { fetchRegisterInviteCode } from "@/lib/api/auth";
import { updateDeviceName } from "@/lib/api/devices";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function RegisterInviteCodeScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const isDark = colorScheme === "dark";
  const [inviteCode, setInviteCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [alertConfig, setAlertConfig] = useState<{ title: string; message?: string; onClose?: () => void } | null>(null);

  const [nicknameModalVisible, setNicknameModalVisible] = useState(false);
  const [registeredDeviceUuid, setRegisteredDeviceUuid] = useState<string | null>(null);
  const [nickname, setNickname] = useState("");

  const showAlert = (title: string, message?: string, onClose?: () => void) =>
    setAlertConfig({ title, message, onClose });

  const handleSubmit = async () => {
    if (!inviteCode.trim()) {
      showAlert("오류", "초대 코드를 입력해주세요.");
      return;
    }
    setLoading(true);
    const result = await fetchRegisterInviteCode(inviteCode.trim());
    setLoading(false);
    if (result.type === "success") {
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

  const handleNicknameConfirm = async () => {
    if (registeredDeviceUuid && nickname.trim()) {
      await updateDeviceName(registeredDeviceUuid, nickname.trim());
    }
    setNicknameModalVisible(false);
    router.back();
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.titleBar, { borderBottomColor: isDark ? "#2a2d2e" : "#e5e7eb" }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={[styles.backText, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.titleText, { color: colors.text }]}>초대 코드 가입</Text>
      </View>
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
          onPress={handleSubmit}
          disabled={loading}
        >
          <Text style={styles.buttonText}>{loading ? "처리 중..." : "확인"}</Text>
        </TouchableOpacity>
      </KeyboardAvoidingView>
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
                style={[styles.button, { backgroundColor: nickname.trim() ? colors.tint : "#9CA3AF", flex: 1 }]}
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
  modalFooter: {
    flexDirection: "row",
    gap: 10,
  },
});
