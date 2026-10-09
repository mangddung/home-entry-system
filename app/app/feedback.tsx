// 해제 타이밍 피드백 (계획서 4.11). 알림을 지웠거나 본문을 눌러 앱이 열린 경우의 경로.
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { loadDevices } from "@/lib/api/devices";
import { loadFeedback, submitFeedback } from "@/lib/proximity";
import { ANSWER_LABEL, type FeedbackAnswer, type FeedbackRecord, feedbackStatus } from "@/lib/proximity-rules";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const ANSWERS: { answer: FeedbackAnswer; hint: string }[] = [
  { answer: "early", hint: "문에 닿기 한참 전에 열렸어요" },
  { answer: "ok", hint: "문 앞에서 딱 맞게 열렸어요" },
  { answer: "late", hint: "문 앞에서 기다렸어요" },
];

export default function FeedbackScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const cardBg = isDark ? "#1e2022" : "#f3f4f6";
  const { id } = useLocalSearchParams<{ id?: string }>();

  const [record, setRecord] = useState<FeedbackRecord | null | undefined>(undefined);
  const [deviceName, setDeviceName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    const rec = (await loadFeedback()).find((r) => r.id === id) ?? null;
    setRecord(rec);
    if (rec) {
      const d = (await loadDevices()).find((x) => x.device_uuid === rec.device_uuid);
      setDeviceName(d?.device_nickname || rec.device_uuid.substring(0, 8));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const submit = async (answer: FeedbackAnswer) => {
    if (!record || submitting) return;
    setSubmitting(true);
    await submitFeedback(record.id, answer, "app");
    await load();
    setSubmitting(false);
  };

  const status = record ? feedbackStatus(record) : null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.titleBar, { borderBottomColor: isDark ? "#2a2d2e" : "#e5e7eb" }]}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/home"))} style={styles.backBtn}>
          <Text style={[styles.backText, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.titleText, { color: colors.text }]}>해제 타이밍 피드백</Text>
      </View>

      <View style={styles.body}>
        {record === undefined ? null : !record ? (
          <Text style={[styles.hint, { color: colors.icon }]}>피드백 항목을 찾을 수 없습니다.</Text>
        ) : (
          <>
            <View style={[styles.card, { backgroundColor: cardBg }]}>
              <Text style={[styles.name, { color: colors.text }]}>{deviceName}</Text>
              <Text style={[styles.hint, { color: colors.icon }]}>{new Date(record.at).toLocaleString()} 자동 해제</Text>
            </View>

            {status === "done" && record.answer ? (
              <Text style={[styles.statusText, { color: "#16a34a" }]}>
                피드백 완료 · {ANSWER_LABEL[record.answer]}
              </Text>
            ) : status === "expired" ? (
              <Text style={[styles.statusText, { color: colors.icon }]}>피드백 가능 시간(3시간)이 지났습니다.</Text>
            ) : (
              <Text style={[styles.question, { color: colors.text }]}>문이 열리는 타이밍은 어땠나요?</Text>
            )}

            {ANSWERS.map(({ answer, hint }) => {
              const selected = record.answer === answer;
              const disabled = status !== "pending" || submitting;
              return (
                <TouchableOpacity
                  key={answer}
                  style={[
                    styles.option,
                    { backgroundColor: cardBg, borderColor: selected ? "#16a34a" : "transparent" },
                    disabled && !selected && { opacity: 0.4 },
                  ]}
                  disabled={disabled}
                  onPress={() => submit(answer)}
                >
                  <Text style={[styles.optionTitle, { color: colors.text }]}>{ANSWER_LABEL[answer]}</Text>
                  <Text style={[styles.hint, { color: colors.icon }]}>{hint}</Text>
                </TouchableOpacity>
              );
            })}
          </>
        )}
      </View>
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
  body: { padding: 24, gap: 12 },
  card: { borderRadius: 14, padding: 16, gap: 4, marginBottom: 8 },
  name: { fontSize: 16, fontWeight: "700" },
  hint: { fontSize: 12 },
  question: { fontSize: 15, fontWeight: "600" },
  statusText: { fontSize: 14, fontWeight: "600" },
  option: { borderRadius: 12, padding: 16, gap: 2, borderWidth: 2 },
  optionTitle: { fontSize: 15, fontWeight: "700" },
});
