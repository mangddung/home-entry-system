// 서보 동작 범위 설정 (마스터). 기준값은 기기 NVS다.
// 화면에 있는 동안 BLE 연결을 유지해 손잡이를 움직이는 대로 서보가 따라오고, 저장은 서버가 서명한 명령으로 한다.
import { CustomAlert } from "@/components/custom-alert";
import { ServoRangeSlider, type ServoRange } from "@/components/servo-range-slider";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { loadDevices } from "@/lib/api/devices";
import { openServoSession, rebondDevice, type ServoSession } from "@/lib/ble";
import type { IoTDevice } from "@/lib/types";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type Status = "connecting" | "need_bond" | "failed" | "ready";

export default function ServoRangeScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const { device_uuid } = useLocalSearchParams<{ device_uuid?: string }>();

  const [device, setDevice] = useState<IoTDevice | null | undefined>(undefined); // undefined = 로딩 중
  const [status, setStatus] = useState<Status>("connecting");
  const [statusMessage, setStatusMessage] = useState("");
  const [range, setRange] = useState<ServoRange | null>(null);
  const [liveDeg, setLiveDeg] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [alertConfig, setAlertConfig] = useState<{ title: string; message: string } | null>(null);
  const sessionRef = useRef<ServoSession | null>(null);
  const leftRef = useRef(false); // 연결 중에 화면을 나가면 세션을 남기지 않는다

  const open = useCallback(async (target: IoTDevice) => {
    setStatus("connecting");
    const result = await openServoSession(target, () => {
      sessionRef.current = null;
      setStatusMessage("기기와 연결이 끊겼습니다. 2분 동안 조작이 없어도 끊깁니다.");
      setStatus("failed");
    });
    if (result.type !== "ready") {
      setStatusMessage(result.message);
      setStatus(result.type);
      return;
    }
    if (leftRef.current) {
      await result.session.close();
      return;
    }
    sessionRef.current = result.session;
    setRange(result.session.range);
    setLiveDeg(null);
    setStatus("ready");
  }, []);

  useEffect(() => {
    leftRef.current = false;
    void (async () => {
      const found = (await loadDevices()).find((d) => d.device_uuid === device_uuid) ?? null;
      setDevice(found);
      if (found?.role === "master") await open(found);
    })();
    return () => {
      leftRef.current = true;
      void sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, [device_uuid, open]);

  const rebond = async () => {
    if (!device) return;
    setStatus("connecting");
    const failure = await rebondDevice(device);
    if (failure) {
      setStatusMessage(failure);
      setStatus("need_bond");
      return;
    }
    await open(device);
  };

  const moveTo = useCallback((deg: number) => {
    setLiveDeg(deg);
    sessionRef.current?.move(deg);
  }, []);

  const save = async () => {
    if (!sessionRef.current || !range) return;
    setBusy(true);
    const failure = await sessionRef.current.save(range.low, range.high);
    setBusy(false);
    setAlertConfig(
      failure
        ? { title: "저장 실패", message: failure }
        : { title: "저장됨", message: "기기가 새 범위로 한 번 움직였습니다." },
    );
  };

  const isConnecting = device === undefined || (device?.role === "master" && status === "connecting");

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <View style={[styles.titleBar, { borderBottomColor: isDark ? "#2a2d2e" : "#e5e7eb" }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} disabled={busy}>
          <Text style={[styles.backText, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.titleText, { color: colors.text }]}>서보 동작 범위</Text>
      </View>

      {isConnecting ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
          <Text style={[styles.centerTitle, { color: colors.text }]}>기기에 연결하는 중입니다</Text>
          <Text style={[styles.hint, styles.centerHint, { color: colors.icon }]}>기기 근처에서 잠시 기다려 주세요.</Text>
        </View>
      ) : device?.role !== "master" ? (
        <View style={styles.body}>
          <Text style={[styles.hint, { color: colors.icon }]}>마스터만 변경할 수 있습니다.</Text>
        </View>
      ) : status === "need_bond" ? (
        <View style={styles.body}>
          <Text style={[styles.hint, { color: colors.icon }]}>
            {statusMessage} 기기 앞에서 연결하면 Android 페어링 확인 창이 한 번 뜹니다.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={rebond}>
            <Text style={styles.primaryText}>이 휴대폰 연결</Text>
          </TouchableOpacity>
        </View>
      ) : status === "failed" || !range ? (
        <View style={styles.body}>
          <Text style={[styles.hint, { color: colors.icon }]}>{statusMessage}</Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => open(device)}>
            <Text style={styles.primaryText}>다시 연결</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.body, styles.sliderBody]}>
          <ServoRangeSlider
            range={range}
            disabled={busy}
            onChange={setRange}
            onDrag={moveTo}
            colors={colors}
            trackColor={isDark ? "#1e2022" : "#f3f4f6"}
            tickColor={isDark ? "#3a3f44" : "#d1d5db"}
          />

          <View style={styles.actions}>
            <View style={styles.liveRow}>
              <Text style={[styles.liveLabel, { color: colors.icon }]}>서보에 보낸 각도</Text>
              <Text style={[styles.liveValue, { color: colors.text }]}>{liveDeg == null ? "-" : `${liveDeg}°`}</Text>
            </View>

            <TouchableOpacity
              style={styles.swapBtn}
              disabled={busy}
              onPress={() => setRange({ low: range.high, high: range.low })}
            >
              <MaterialCommunityIcons name="swap-vertical" size={16} color={colors.icon} />
              <Text style={[styles.swapText, { color: colors.icon }]}>방향 바꾸기</Text>
            </TouchableOpacity>

            <Text style={[styles.hint, { color: colors.icon }]}>
              손잡이를 잡으면 서보가 그 각도로 바로 움직여 잠금이 풀릴 수 있습니다. 걸리는 소리가 나면 범위를 줄이세요.
              저장하지 않고 나가면 원래 대기 각도로 돌아갑니다.
            </Text>

            <TouchableOpacity style={[styles.primaryBtn, busy && { opacity: 0.5 }]} disabled={busy} onPress={save}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>저장 후 동작 확인</Text>}
            </TouchableOpacity>
          </View>
        </View>
      )}

      <CustomAlert
        visible={!!alertConfig}
        title={alertConfig?.title ?? ""}
        message={alertConfig?.message}
        buttons={[{ text: "확인" }]}
        onRequestClose={() => setAlertConfig(null)}
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
  body: { padding: 24, gap: 14 },
  sliderBody: { flex: 1, justifyContent: "space-between", gap: 20 },
  actions: { gap: 12 },
  liveRow: { flexDirection: "row", alignItems: "baseline", justifyContent: "center", gap: 8 },
  liveLabel: { fontSize: 13 },
  liveValue: { fontSize: 20, fontWeight: "700", fontVariant: ["tabular-nums"] },
  swapBtn: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  swapText: { fontSize: 13, fontWeight: "600" },
  hint: { fontSize: 12, lineHeight: 18 },
  primaryBtn: { backgroundColor: "#16a34a", borderRadius: 10, paddingVertical: 13, alignItems: "center" },
  primaryText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 8 },
  centerTitle: { marginTop: 8, fontSize: 15, fontWeight: "600" },
  centerHint: { textAlign: "center" },
});
