// 근접 해제 보정 (계획서 4.11). 문 앞 기준점에서 2~3m, 폰은 주머니에 넣고 광고 RSSI 중앙값을 잰다.
// 마스터: 기기 임계값(서버, 모든 멤버 기본값) 또는 내 기준. 멤버: 내 기준(폰 로컬, 기기별).
import { CustomAlert } from "@/components/custom-alert";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { fetchDevices, loadDevices, updateRssiThreshold } from "@/lib/api/devices";
import { startRssiScan } from "@/lib/ble";
import { loadCalibrations, resetCalibration, setReferenceRssi } from "@/lib/proximity";
import { type Calibration, effectiveThreshold, median } from "@/lib/proximity-rules";
import type { IoTDevice } from "@/lib/types";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const POCKET_DELAY_S = 3; // 시작 후 주머니에 넣을 시간
const MEASURE_S = 8;
const MIN_SAMPLES = 5;

type Phase = { kind: "idle" } | { kind: "countdown"; left: number } | { kind: "measuring"; left: number };

export default function RssiCalibrateScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const cardBg = isDark ? "#1e2022" : "#f3f4f6";
  const { device_uuid, from } = useLocalSearchParams<{ device_uuid?: string; from?: string }>();

  const [device, setDevice] = useState<IoTDevice | null | undefined>(undefined); // undefined = 로딩 중
  const [cal, setCal] = useState<Calibration | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [result, setResult] = useState<{ median: number; count: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [alertConfig, setAlertConfig] = useState<{ title: string; message?: string; onClose?: () => void } | null>(null);
  const stopScanRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const find = async () => (await loadDevices()).find((d) => d.device_uuid === device_uuid);
    let found = await find();
    if (!found) {
      // 방금 등록·가입한 기기는 아직 캐시에 없을 수 있다
      await fetchDevices();
      found = await find();
    }
    setDevice(found ?? null);
    setCal((await loadCalibrations())[device_uuid ?? ""]);
  }, [device_uuid]);

  const cleanup = useCallback(() => {
    stopScanRef.current?.();
    stopScanRef.current = null;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => {
    void load();
    return cleanup;
  }, [load, cleanup]);

  const done = () => (from === "setup" || !router.canGoBack() ? router.replace("/home") : router.back());

  const start = () => {
    if (!device) return;
    setResult(null);
    let left = POCKET_DELAY_S;
    setPhase({ kind: "countdown", left });
    timerRef.current = setInterval(async () => {
      left -= 1;
      if (left > 0) return setPhase({ kind: "countdown", left });
      if (timerRef.current) clearInterval(timerRef.current);
      await measure();
    }, 1000);
  };

  const measure = async () => {
    if (!device) return;
    const samples: number[] = [];
    let stop: (() => void) | null = null;
    try {
      stop = await startRssiScan([device.ble_uuids.ble_service_uuid], (_, rssi) => samples.push(rssi));
    } catch {
      stop = null;
    }
    if (!stop) {
      setPhase({ kind: "idle" });
      setAlertConfig({ title: "측정 불가", message: "다른 BLE 스캔이 진행 중이거나 블루투스를 사용할 수 없습니다. 잠시 후 다시 시도하세요." });
      return;
    }
    stopScanRef.current = stop;
    let left = MEASURE_S;
    setPhase({ kind: "measuring", left });
    timerRef.current = setInterval(() => {
      left -= 1;
      if (left > 0) return setPhase({ kind: "measuring", left });
      cleanup();
      setPhase({ kind: "idle" });
      if (samples.length < MIN_SAMPLES) {
        setAlertConfig({ title: "신호 부족", message: "기기 신호를 충분히 받지 못했습니다. 기기 전원과 거리를 확인하고 다시 측정하세요." });
        return;
      }
      setResult({ median: Math.round(median(samples)), count: samples.length });
    }, 1000);
  };

  const saveDevice = async () => {
    if (!device || !result) return;
    setSaving(true);
    const res = await updateRssiThreshold(device.device_uuid, result.median);
    if (res.type === "success") await fetchDevices();
    setSaving(false);
    if (res.type !== "success") {
      setAlertConfig({ title: "저장 실패", message: res.message });
      return;
    }
    setAlertConfig({ title: "저장됨", message: `기기 기준 ${result.median} dBm (모든 멤버 기본값)`, onClose: done });
  };

  const saveMine = async () => {
    if (!device || !result) return;
    await setReferenceRssi(device.device_uuid, result.median);
    setAlertConfig({ title: "저장됨", message: `내 기준 ${result.median} dBm (이 폰, 이 기기에만 적용)`, onClose: done });
  };

  const resetMine = async () => {
    if (!device) return;
    await resetCalibration(device.device_uuid);
    await load();
  };

  const busy = phase.kind !== "idle" || saving;
  const isMaster = device?.role === "master";
  const applied = device ? effectiveThreshold(cal, device.rssi_threshold) : null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.titleBar, { borderBottomColor: isDark ? "#2a2d2e" : "#e5e7eb" }]}>
        <TouchableOpacity onPress={done} style={styles.backBtn} disabled={busy}>
          <Text style={[styles.backText, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.titleText, { color: colors.text }]}>근접 해제 보정</Text>
      </View>

      {device === undefined ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={colors.icon} />
      ) : !device ? (
        <View style={styles.body}>
          <Text style={[styles.hint, { color: colors.icon }]}>기기를 찾을 수 없습니다.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <View style={[styles.card, { backgroundColor: cardBg }]}>
            <Text style={[styles.name, { color: colors.text }]}>{device.device_nickname || device.device_uuid.substring(0, 8)}</Text>
            <Row label="기기 기준 (마스터)" value={device.rssi_threshold != null ? `${device.rssi_threshold} dBm` : "미설정"} colors={colors} />
            <Row
              label="내 기준"
              value={cal ? `${cal.ref_rssi} dBm${cal.adjust_db ? ` (피드백 ${cal.adjust_db > 0 ? "+" : ""}${cal.adjust_db})` : ""}` : "없음"}
              colors={colors}
            />
            <Row label="적용 중" value={applied != null ? `${applied} dBm` : "발견 즉시 열림"} colors={colors} />
          </View>

          <Text style={[styles.hint, { color: colors.icon }]}>
            문 앞 기준점(예: 현관 매트 바깥)에서 2~3m 떨어진 곳에 서세요. 측정 시작을 누르고 {POCKET_DELAY_S}초 안에 폰을 주머니에 넣으면 {MEASURE_S}초 동안 측정합니다.
            {"\n"}가족 모두 같은 기준점에서 측정해야 합니다.
          </Text>

          <TouchableOpacity style={[styles.primaryBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={start}>
            {phase.kind === "idle" ? (
              <Text style={styles.primaryText}>{result ? "다시 측정" : "측정 시작"}</Text>
            ) : (
              <View style={styles.btnRow}>
                <ActivityIndicator color="#fff" />
                <Text style={styles.primaryText}>
                  {phase.kind === "countdown" ? `주머니에 넣으세요 · ${phase.left}` : `측정 중 · ${phase.left}`}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          {result && (
            <View style={[styles.card, { backgroundColor: cardBg }]}>
              <Text style={[styles.resultValue, { color: colors.text }]}>{result.median} dBm</Text>
              <Text style={[styles.hint, { color: colors.icon }]}>중앙값 · 샘플 {result.count}개</Text>
              {isMaster && (
                <TouchableOpacity style={[styles.primaryBtn, saving && { opacity: 0.5 }]} disabled={saving} onPress={saveDevice}>
                  <Text style={styles.primaryText}>기기 기준으로 저장 (모든 멤버)</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={[styles.secondaryBtn, { borderColor: colors.icon }]} disabled={saving} onPress={saveMine}>
                <Text style={[styles.secondaryText, { color: colors.text }]}>내 기준으로만 저장 (이 폰)</Text>
              </TouchableOpacity>
            </View>
          )}

          {cal && (
            <TouchableOpacity onPress={resetMine} disabled={busy}>
              <Text style={styles.resetText}>내 보정 초기화 (기기 기준 사용)</Text>
            </TouchableOpacity>
          )}
        </ScrollView>
      )}

      <CustomAlert
        visible={!!alertConfig}
        title={alertConfig?.title ?? ""}
        message={alertConfig?.message}
        buttons={[{ text: "확인", onPress: alertConfig?.onClose }]}
        onRequestClose={() => setAlertConfig(null)}
      />
    </SafeAreaView>
  );
}

function Row({ label, value, colors }: { label: string; value: string; colors: { text: string; icon: string } }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: colors.icon }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: colors.text }]}>{value}</Text>
    </View>
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
  body: { padding: 24, gap: 14 },
  card: { borderRadius: 14, padding: 16, gap: 8 },
  name: { fontSize: 16, fontWeight: "700", marginBottom: 4 },
  row: { flexDirection: "row", justifyContent: "space-between" },
  rowLabel: { fontSize: 13 },
  rowValue: { fontSize: 13, fontWeight: "600" },
  hint: { fontSize: 12, lineHeight: 18 },
  primaryBtn: { backgroundColor: "#16a34a", borderRadius: 10, paddingVertical: 13, alignItems: "center" },
  primaryText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  btnRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  secondaryBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  secondaryText: { fontSize: 14, fontWeight: "600" },
  resultValue: { fontSize: 28, fontWeight: "700", fontVariant: ["tabular-nums"] },
  resetText: { color: "#ef4444", fontSize: 13, textAlign: "center", paddingVertical: 8 },
});
