// 디버그: 등록된 기기의 광고 RSSI 실측 (근접 해제 임계값 보정용, 계획서 4.11)
// 연결 없이 광고만 받는다. 측정 중에는 백그라운드 BLE 스캔이 건너뛰어진다.

import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { loadDevices } from "@/lib/api/devices";
import { startRssiScan } from "@/lib/ble";
import type { IoTDevice } from "@/lib/types";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";

const REFRESH_MS = 500;

const ROLE_LABEL: Record<string, string> = { master: "마스터", member: "멤버", guest: "게스트" };

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

export default function DebugScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const cardBg = isDark ? "#1e2022" : "#f3f4f6";

  const [devices, setDevices] = useState<IoTDevice[]>([]);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const samplesRef = useRef(new Map<string, number[]>()); // key: 서비스 UUID(소문자)
  const stopRef = useRef<(() => void) | null>(null);

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setScanning(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void loadDevices().then((list) => setDevices(list.filter((d) => !!d.ble_uuids?.ble_service_uuid)));
      return stop; // 탭을 벗어나면 스캔 중지
    }, [stop]),
  );

  // 콜백마다 렌더하지 않고 일정 주기로만 화면 갱신
  useEffect(() => {
    if (!scanning) return;
    const id = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, [scanning]);

  const start = async () => {
    setMessage(null);
    samplesRef.current = new Map();
    try {
      const stopFn = await startRssiScan(
        devices.map((d) => d.ble_uuids.ble_service_uuid as string),
        (uuid, rssi) => {
          const arr = samplesRef.current.get(uuid) ?? [];
          arr.push(rssi);
          samplesRef.current.set(uuid, arr);
        },
      );
      if (!stopFn) {
        setMessage("다른 BLE 스캔이 진행 중이거나 권한이 없습니다. 잠시 후 다시 시도하세요.");
        return;
      }
      stopRef.current = stopFn;
      setStartedAt(Date.now());
      setScanning(true);
    } catch (e: any) {
      setMessage(e?.message ?? "스캔을 시작할 수 없습니다.");
    }
  };

  const reset = () => {
    samplesRef.current = new Map();
    setStartedAt(scanning ? Date.now() : null);
    setTick((t) => t + 1);
  };

  const elapsedSec = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>디버그</Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.icon }]}>RSSI 측정</Text>
        <View style={styles.btnRow}>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: scanning ? "#ef4444" : "#16a34a" }]}
            onPress={scanning ? stop : start}
            disabled={!scanning && devices.length === 0}
          >
            <Text style={styles.btnText}>{scanning ? "측정 중지" : "측정 시작"}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.btn, { backgroundColor: cardBg }]} onPress={reset}>
            <Text style={[styles.btnText, { color: colors.text }]}>초기화</Text>
          </TouchableOpacity>
        </View>
        <Text style={[styles.hint, { color: colors.icon }]}>
          {scanning ? `측정 중 · ${elapsedSec}초 경과` : "기준 지점에서 5~10초 측정 후 중앙값을 사용하세요."}
        </Text>
        {message && <Text style={styles.error}>{message}</Text>}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.icon }]}>등록된 기기</Text>
        {devices.length === 0 ? (
          <Text style={[styles.hint, { color: colors.icon }]}>등록된 기기가 없습니다.</Text>
        ) : (
          devices.map((d) => {
            const samples = samplesRef.current.get((d.ble_uuids.ble_service_uuid as string).toLowerCase()) ?? [];
            const has = samples.length > 0;
            return (
              <View key={d.device_uuid} style={[styles.card, { backgroundColor: cardBg }]}>
                <View style={styles.cardHead}>
                  <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                    {d.device_nickname || d.device_uuid.substring(0, 8)}
                  </Text>
                  <Text style={[styles.role, { color: colors.icon }]}>{ROLE_LABEL[d.role] ?? d.role}</Text>
                </View>
                <View style={styles.statRow}>
                  <Stat label="현재" value={has ? `${samples[samples.length - 1]}` : "-"} color={colors.text} sub={colors.icon} />
                  <Stat label="중앙값" value={has ? `${median(samples)}` : "-"} color={colors.text} sub={colors.icon} />
                  <Stat label="최소/최대" value={has ? `${Math.min(...samples)}/${Math.max(...samples)}` : "-"} color={colors.text} sub={colors.icon} />
                  <Stat label="샘플" value={`${samples.length}`} color={colors.text} sub={colors.icon} />
                </View>
              </View>
            );
          })
        )}
      </View>
    </ScrollView>
  );
}

function Stat({ label, value, color, sub }: { label: string; value: string; color: string; sub: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statLabel, { color: sub }]}>{label}</Text>
      <Text style={[styles.statValue, { color }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, gap: 24 },
  header: { paddingVertical: 8 },
  headerTitle: { fontSize: 28, fontWeight: "700" },
  section: { gap: 10 },
  sectionTitle: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8 },
  btnRow: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, paddingVertical: 12, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  hint: { fontSize: 12 },
  error: { fontSize: 12, color: "#ef4444" },
  card: { borderRadius: 14, padding: 14, gap: 10 },
  cardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  name: { fontSize: 15, fontWeight: "600", flexShrink: 1 },
  role: { fontSize: 12 },
  statRow: { flexDirection: "row", justifyContent: "space-between" },
  stat: { alignItems: "center", flex: 1 },
  statLabel: { fontSize: 11 },
  statValue: { fontSize: 16, fontWeight: "700", fontVariant: ["tabular-nums"] },
});
