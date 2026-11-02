// 서보 동작 범위 설정 (마스터). 기준값은 기기 NVS라 BLE로 읽고, 저장은 서버가 서명한 명령을 BLE로 전달한다.
import { CustomAlert } from "@/components/custom-alert";
import { ServoRangeSlider, type ServoRange } from "@/components/servo-range-slider";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { loadDevices, signServoCommand } from "@/lib/api/devices";
import { exchangeServoCommand } from "@/lib/ble";
import type { IoTDevice } from "@/lib/types";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const parseRange = (reply: string | null): ServoRange | null => {
  const match = reply?.match(/^SRV:(\d+):(\d+)$/);
  return match ? { low: Number(match[1]), high: Number(match[2]) } : null;
};

export default function ServoRangeScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const { device_uuid } = useLocalSearchParams<{ device_uuid?: string }>();

  const [device, setDevice] = useState<IoTDevice | null | undefined>(undefined); // undefined = 로딩 중
  const [range, setRange] = useState<ServoRange | null>(null);
  const [busy, setBusy] = useState(false);
  const [alertConfig, setAlertConfig] = useState<{ title: string; message: string } | null>(null);

  const readRange = useCallback(async (target: IoTDevice) => {
    setBusy(true);
    const reply = await exchangeServoCommand(target, async () => "SRV?");
    setRange(parseRange(reply));
    setBusy(false);
  }, []);

  useEffect(() => {
    void (async () => {
      const found = (await loadDevices()).find((d) => d.device_uuid === device_uuid) ?? null;
      setDevice(found);
      if (found?.role === "master") await readRange(found);
    })();
  }, [device_uuid, readRange]);

  const save = async () => {
    if (!device || !range) return;
    setBusy(true);
    let failure = "기기에 연결하지 못했습니다. 문 앞에서 다시 시도하세요.";
    const reply = await exchangeServoCommand(device, async (nonce) => {
      const res = await signServoCommand(device.device_uuid, range.low, range.high, nonce);
      if (res.type === "success") return res.command;
      failure = res.message;
      return null;
    });
    setBusy(false);
    if (reply === "SRV_OK") {
      setAlertConfig({ title: "저장됨", message: "기기가 새 범위로 한 번 움직였습니다." });
    } else {
      setAlertConfig({
        title: "저장 실패",
        message: reply === "SRV_FAIL" ? "기기가 명령을 거부했습니다. 다시 시도하세요." : failure,
      });
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top", "bottom"]}>
      <View style={[styles.titleBar, { borderBottomColor: isDark ? "#2a2d2e" : "#e5e7eb" }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn} disabled={busy}>
          <Text style={[styles.backText, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.titleText, { color: colors.text }]}>서보 동작 범위</Text>
      </View>

      {device === undefined || (busy && !range) ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={colors.tint} />
          <Text style={[styles.centerTitle, { color: colors.text }]}>기기에 연결하는 중입니다</Text>
          <Text style={[styles.hint, styles.centerHint, { color: colors.icon }]}>기기 근처에서 잠시 기다려 주세요.</Text>
        </View>
      ) : device?.role !== "master" ? (
        <View style={styles.body}>
          <Text style={[styles.hint, { color: colors.icon }]}>마스터만 변경할 수 있습니다.</Text>
        </View>
      ) : !range ? (
        <View style={styles.body}>
          <Text style={[styles.hint, { color: colors.icon }]}>
            기기에서 현재 범위를 읽지 못했습니다. 기기 전원을 확인하고 문 앞에서 다시 시도하세요.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => readRange(device)}>
            <Text style={styles.primaryText}>다시 연결</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={[styles.body, styles.sliderBody]}>
          <ServoRangeSlider
            range={range}
            disabled={busy}
            onChange={setRange}
            colors={colors}
            trackColor={isDark ? "#1e2022" : "#f3f4f6"}
            tickColor={isDark ? "#3a3f44" : "#d1d5db"}
          />

          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.swapBtn}
              disabled={busy}
              onPress={() => setRange({ low: range.high, high: range.low })}
            >
              <MaterialCommunityIcons name="swap-vertical" size={16} color={colors.icon} />
              <Text style={[styles.swapText, { color: colors.icon }]}>방향 바꾸기</Text>
            </TouchableOpacity>

            <Text style={[styles.hint, { color: colors.icon }]}>
              저장하면 새 범위로 한 번 움직여 잠금이 풀릴 수 있습니다. 걸리는 소리가 나면 범위를 줄이세요.
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
