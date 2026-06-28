import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";

export interface AlertButton {
  text: string;
  onPress?: () => void;
  style?: "default" | "cancel" | "destructive";
}

interface Props {
  visible: boolean;
  title: string;
  message?: string;
  buttons?: AlertButton[];
  onRequestClose?: () => void;
}

export function CustomAlert({ visible, title, message, buttons, onRequestClose }: Props) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];

  const resolvedButtons: AlertButton[] = buttons?.length ? buttons : [{ text: "확인" }];
  const dividerColor = isDark ? "#2C3237" : "#E8ECF0";

  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent onRequestClose={onRequestClose}>
      <Pressable style={styles.backdrop} onPress={onRequestClose}>
        <Pressable style={[styles.card, { backgroundColor: isDark ? "#1E2124" : "#fff" }]}>
          <View style={styles.content}>
            <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
            {message ? (
              <Text style={[styles.message, { color: colors.tabIconDefault }]}>{message}</Text>
            ) : null}
          </View>
          <View style={[styles.divider, { backgroundColor: dividerColor }]} />
          <View style={styles.btnRow}>
            {resolvedButtons.map((btn, i) => {
              const isDestructive = btn.style === "destructive";
              const isCancel = btn.style === "cancel";
              return (
                <TouchableOpacity
                  key={i}
                  style={[
                    styles.btn,
                    i > 0 && { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: dividerColor },
                  ]}
                  onPress={() => {
                    btn.onPress?.();
                    onRequestClose?.();
                  }}
                  activeOpacity={0.6}
                >
                  <Text
                    style={[
                      styles.btnText,
                      isCancel && { color: colors.tabIconDefault, fontWeight: "400" },
                      isDestructive && { color: "#EF4444" },
                      !isCancel && !isDestructive && { color: colors.tint },
                    ]}
                  >
                    {btn.text}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.45)",
    justifyContent: "center",
    alignItems: "center",
    padding: 48,
  },
  card: {
    width: "100%",
    borderRadius: 18,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.2,
    shadowRadius: 24,
    elevation: 12,
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 28,
    paddingBottom: 20,
    gap: 8,
    alignItems: "center",
  },
  title: {
    fontSize: 17,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: -0.2,
  },
  message: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
  },
  btnRow: {
    flexDirection: "row",
  },
  btn: {
    flex: 1,
    paddingVertical: 16,
    alignItems: "center",
  },
  btnText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
