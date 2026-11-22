// 개발자 도구 > 디버그 설정. 테스트할 때 자동 인증 경로의 동작·로그를 켜고 끈다.
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { cancelGeofenceEventNotifications, updateGeoFence } from "@/lib/background-tracking";
import { type DevSettings, GEOFENCE_RADIUS_OPTIONS, getDevSettings, setDevSetting } from "@/lib/dev-settings";
import { Provider, Switch } from "@ant-design/react-native";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

type BoolKey = Exclude<keyof DevSettings, "geofenceRadiusM">;

const SECTIONS: { title: string; radius?: true; items: { key: BoolKey; label: string; hint: string }[] }[] = [
  {
    title: "지오펜스",
    radius: true,
    items: [
      { key: "geofenceNotify", label: "진입·이탈 알림", hint: "반경에 들어오거나 나갈 때 거리·위치 시각을 알림으로 띄웁니다." },
      { key: "geofenceLocationLog", label: "진입·이탈 위치 기록", hint: "그때의 좌표·정확도를 시스템 로그의 GPS 탭에 남깁니다." },
    ],
  },
  {
    title: "자동 해제",
    items: [
      {
        key: "stillCheck",
        label: "정지 판정(걸음 센서)",
        hint: "5분 넘게 걷지 않았으면 자동 해제를 보류합니다(릴레이 공격 완화). 끄면 걷지 않아도 바로 시도합니다. 테스트할 때만 끄세요.",
      },
      { key: "rssiGate", label: "근접 문턱(RSSI)", hint: "끄면 문턱 없이 기기를 발견하는 즉시 연결합니다." },
      { key: "wakeLock", label: "추적 중 CPU 유지", hint: "추적하는 동안 화면이 꺼져도 타이머가 돌게 합니다. 끄면 배터리 영향 비교용입니다. 다음 추적부터 반영됩니다." },
    ],
  },
  {
    title: "로그",
    items: [{ key: "stillHeartbeat", label: "정지 대기 진단 로그", hint: "자동 해제를 보류하는 동안 1분마다 자동 인증 로그에 상태를 남깁니다." }],
  },
];

export default function DevSettingsScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const cardBg = isDark ? "#1e2022" : "#f3f4f6";
  const dividerColor = isDark ? "#2a2d2e" : "#e5e7eb";
  const [settings, setSettings] = useState<DevSettings | null>(null);
  const [radiusStatus, setRadiusStatus] = useState<string | null>(null);

  useEffect(() => {
    getDevSettings().then(setSettings);
  }, []);

  const toggle = (key: BoolKey, on: boolean) => {
    setSettings((s) => (s ? { ...s, [key]: on } : s));
    void setDevSetting(key, on);
    // 진입·이탈 알림은 고정이라 사용자가 지울 수 없으므로 끌 때 함께 내린다
    if (key === "geofenceNotify" && !on) void cancelGeofenceEventNotifications();
  };

  // 반경은 등록에 들어가므로 저장 후 바로 재등록한다(이미 반경 안이면 진입 이벤트가 다시 온다)
  const changeRadius = async (radius: number) => {
    setSettings((s) => (s ? { ...s, geofenceRadiusM: radius } : s));
    setRadiusStatus("재등록 중…");
    await setDevSetting("geofenceRadiusM", radius);
    try {
      await updateGeoFence();
      setRadiusStatus(`${radius}m로 재등록했습니다`);
    } catch (e) {
      setRadiusStatus(`재등록 실패: ${e}`);
    }
  };

  return (
    <Provider>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
        <View style={[styles.titleBar, { borderBottomColor: dividerColor }]}>
          <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/settings"))} style={styles.backBtn}>
            <Text style={[styles.backText, { color: colors.text }]}>‹</Text>
          </TouchableOpacity>
          <Text style={[styles.titleText, { color: colors.text }]}>디버그 설정</Text>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {SECTIONS.map((section) => (
            <View key={section.title} style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.icon }]}>{section.title}</Text>
              <View style={[styles.card, { backgroundColor: cardBg }]}>
                {section.radius && (
                  <View style={styles.row}>
                    <View style={styles.rowText}>
                      <Text style={[styles.label, { color: colors.text }]}>반경</Text>
                      <Text style={[styles.hint, { color: colors.icon }]}>
                        {radiusStatus ?? "넓히면 걸어서 경계를 지나는 동안 진입을 잡을 여유가 늘지만 추적이 더 일찍 시작됩니다. 지도의 원은 기본값으로 그려집니다."}
                      </Text>
                      {settings && (
                        <View style={[styles.segment, { backgroundColor: dividerColor }]}>
                          {GEOFENCE_RADIUS_OPTIONS.map((r) => {
                            const selected = settings.geofenceRadiusM === r;
                            return (
                              <TouchableOpacity
                                key={r}
                                style={[styles.segmentItem, selected && { backgroundColor: "#3B82F6" }]}
                                onPress={() => !selected && void changeRadius(r)}
                              >
                                <Text style={[styles.segmentText, { color: selected ? "#fff" : colors.icon }]}>{r}m</Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      )}
                    </View>
                  </View>
                )}
                {section.items.map((item, i) => (
                  <View key={item.key}>
                    {(i > 0 || section.radius) && <View style={[styles.divider, { backgroundColor: dividerColor }]} />}
                    <View style={styles.row}>
                      <View style={styles.rowText}>
                        <Text style={[styles.label, { color: colors.text }]}>{item.label}</Text>
                        <Text style={[styles.hint, { color: colors.icon }]}>{item.hint}</Text>
                      </View>
                      {settings && <Switch checked={settings[item.key]} onChange={(on) => toggle(item.key, on)} />}
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ))}
        </ScrollView>
      </SafeAreaView>
    </Provider>
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
  body: { padding: 16, gap: 24 },
  section: { gap: 10 },
  sectionTitle: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8 },
  card: { borderRadius: 14, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
  rowText: { flex: 1, gap: 2 },
  label: { fontSize: 15 },
  hint: { fontSize: 12, lineHeight: 17 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  segment: { flexDirection: "row", alignSelf: "flex-start", borderRadius: 8, padding: 2, marginTop: 8 },
  segmentItem: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  segmentText: { fontSize: 12, fontWeight: "600" },
});
