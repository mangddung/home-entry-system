import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { fetchDevices, loadDevices } from "@/lib/api/devices";
import { userTokenExchange } from "@/lib/ble";
import { DEBUG_LOG, GEOFENCE_RADIUS_M } from "@/lib/constants";
import type { DebugLog, IoTDevice } from "@/lib/types";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { router } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

const mapHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    #map { width: 100%; height: 100vh; }
  </style>
</head>
<body>
  <div id="map"></div>
  <script>
    var map = L.map('map').setView([37.5665, 126.9780], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    var layers = [];
    function setDevice(d) {
      layers.forEach(function(l) { map.removeLayer(l); });
      layers = [];
      var lat = d.latitude, lon = d.longitude, range = ${GEOFENCE_RADIUS_M};
      var icon = L.divIcon({
        className: '',
        html: '<div style="background:#1d4ed8;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;">장치</div>',
        iconAnchor: [20, 8]
      });
      var m = L.marker([lat, lon], { icon: icon }).addTo(map)
        .bindPopup('범위: ' + range + 'm');
      var c = L.circle([lat, lon], { radius: range, color: '#1d4ed8', fillOpacity: 0.12 }).addTo(map);
      layers.push(m, c);
      map.setView([lat, lon], 15);
    }
  </script>
</body>
</html>
`;

const ROLE_LABEL: Record<string, string> = { master: "마스터", member: "멤버", guest: "게스트" };

const fmtDate = (v: string | null | undefined) => (v ? new Date(v).toLocaleString() : "없음");

export default function DeviceDebugScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const cardBg = isDark ? "#1e2022" : "#f3f4f6";
  const borderColor = isDark ? "#2a2d2e" : "#e5e7eb";

  const [devices, setDevices] = useState<IoTDevice[] | null>(null); // null = 로딩 중
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const webViewRef = useRef<WebView>(null);
  const mapReadyRef = useRef(false);
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logs, setLogs] = useState<DebugLog[]>([]);
  const [sending, setSending] = useState(false);

  const fetchLogs = async () => {
    const raw = await AsyncStorage.getItem(DEBUG_LOG);
    const parsed: DebugLog[] = raw ? JSON.parse(raw) : [];
    setLogs([...parsed].reverse());
  };

  const openLogModal = async () => {
    await fetchLogs();
    setLogModalVisible(true);
  };

  useEffect(() => {
    if (!logModalVisible) return;
    const id = setInterval(fetchLogs, 1000);
    return () => clearInterval(id);
  }, [logModalVisible]);

  const device: IoTDevice | null = devices?.[index] ?? null;

  useEffect(() => {
    void (async () => {
      const result = await fetchDevices();
      if (result.type !== "success") {
        setError(result.message);
      }
      setDevices(await loadDevices());
    })();
  }, []);

  const injectLocation = (loc: IoTDevice["location"]) => {
    if (!mapReadyRef.current || !loc) return;
    webViewRef.current?.injectJavaScript(`setDevice(${JSON.stringify(loc)}); true;`);
  };

  useEffect(() => {
    injectLocation(device?.location ?? null);
  }, [index, devices]);

  const sendToken = async () => {
    if (!device) return;
    setSending(true);
    try {
      await userTokenExchange(device);
    } finally {
      setSending(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <View style={[styles.titleBar, { borderBottomColor: borderColor }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Text style={[styles.backText, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>
        <Text style={[styles.titleText, { color: colors.text }]}>디바이스 디버그</Text>
      </View>

      {devices === null ? (
        <ActivityIndicator style={{ marginTop: 32 }} color={colors.icon} />
      ) : !device ? (
        <View style={styles.body}>
          {!!error && <Text style={styles.error}>{error}</Text>}
          <Text style={[styles.hint, { color: colors.icon }]}>등록된 기기가 없습니다.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          {!!error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.pager}>
            <TouchableOpacity disabled={index === 0} onPress={() => setIndex((i) => i - 1)} style={styles.pageBtn}>
              <Text style={[styles.pageArrow, { color: colors.text }, index === 0 && styles.disabled]}>‹</Text>
            </TouchableOpacity>
            <View style={styles.pageCenter}>
              <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                {device.device_nickname || device.device_uuid.substring(0, 8)}
              </Text>
              <Text style={[styles.hint, { color: colors.icon }]}>
                {index + 1} / {devices.length} · {ROLE_LABEL[device.role] ?? device.role}
              </Text>
            </View>
            <TouchableOpacity
              disabled={index === devices.length - 1}
              onPress={() => setIndex((i) => i + 1)}
              style={styles.pageBtn}
            >
              <Text style={[styles.pageArrow, { color: colors.text }, index === devices.length - 1 && styles.disabled]}>›</Text>
            </TouchableOpacity>
          </View>

          <Section title="기기" colors={colors}>
            <View style={[styles.card, { backgroundColor: cardBg }]}>
              <Field label="기기 UUID" value={device.device_uuid} colors={colors} />
            </View>
          </Section>

          <Section title="BLE" colors={colors}>
            <View style={[styles.card, { backgroundColor: cardBg }]}>
              <Field label="서비스 UUID" value={device.ble_uuids.ble_service_uuid} colors={colors} />
              <Field label="쓰기 UUID" value={device.ble_uuids.ble_write_uuid} colors={colors} />
              <Field label="읽기 UUID" value={device.ble_uuids.ble_read_uuid} colors={colors} />
              <Field label="제조사 UUID" value={device.ble_uuids.ble_manufacturer_uuid} colors={colors} />
            </View>
          </Section>

          <Section title="인증 토큰" colors={colors}>
            <View style={[styles.card, { backgroundColor: cardBg }]}>
              {device.auth_token ? (
                <>
                  <Field label="토큰" value={device.auth_token.token_value} colors={colors} />
                  <Row label="사용 횟수" value={`${device.auth_token.use_count} / ${device.auth_token.max_uses ?? "∞"}`} colors={colors} />
                  <Row label="시작" value={fmtDate(device.auth_token.not_before)} colors={colors} />
                  <Row label="만료" value={fmtDate(device.auth_token.expired_at)} colors={colors} />
                </>
              ) : (
                <Text style={[styles.hint, { color: colors.icon }]}>토큰 없음</Text>
              )}
            </View>
          </Section>

          <TouchableOpacity style={[styles.secondaryBtn, { borderColor: colors.icon }]} onPress={openLogModal}>
            <Text style={[styles.secondaryText, { color: colors.text }]}>디버그 로그</Text>
          </TouchableOpacity>

          <Section title="위치" colors={colors}>
            <View style={[styles.mapCard, { backgroundColor: cardBg }]}>
              <WebView
                ref={webViewRef}
                source={{ html: mapHTML }}
                style={[styles.map, !device.location && styles.hidden]}
                javaScriptEnabled
                domStorageEnabled
                originWhitelist={["*"]}
                nestedScrollEnabled
                onLoad={() => {
                  mapReadyRef.current = true;
                  injectLocation(device.location);
                }}
              />
              {!device.location && (
                <View style={styles.noLocation}>
                  <Text style={[styles.hint, { color: colors.icon }]}>위치 정보 없음</Text>
                </View>
              )}
            </View>
          </Section>
        </ScrollView>
      )}

      <Modal
        visible={logModalVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setLogModalVisible(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={StyleSheet.absoluteFill}
            activeOpacity={1}
            onPress={() => setLogModalVisible(false)}
          />
          <View style={[styles.modalSheet, { backgroundColor: colors.background }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: colors.text }]}>디버그 로그</Text>
              <View style={styles.modalActions}>
                <TouchableOpacity
                  style={[styles.smallBtn, sending && { opacity: 0.5 }]}
                  disabled={sending}
                  onPress={sendToken}
                >
                  {sending ? <ActivityIndicator size="small" color="#fff" /> : <Text style={styles.smallBtnText}>토큰 전송</Text>}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => setLogModalVisible(false)}>
                  <Text style={[styles.modalClose, { color: colors.icon }]}>✕</Text>
                </TouchableOpacity>
              </View>
            </View>
            {logs.length === 0 ? (
              <Text style={[styles.logEmpty, { color: colors.icon }]}>로그 없음</Text>
            ) : (
              <FlatList
                style={{ flexShrink: 1 }}
                data={logs}
                keyExtractor={(_, i) => String(i)}
                renderItem={({ item }) => (
                  <View style={[styles.logItem, { borderBottomColor: borderColor }]}>
                    <Text style={[styles.logTimestamp, { color: colors.icon }]}>{item.timestamp}</Text>
                    <Text style={[styles.logMessage, { color: colors.text }]}>
                      <Text
                        style={[
                          styles.logType,
                          { color: item.log_type === "WARNING" ? "#f59e0b" : "#3b82f6" },
                        ]}
                      >
                        [{item.log_type}]
                      </Text>
                      {"  "}
                      {item.message}
                    </Text>
                  </View>
                )}
              />
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

type ThemeColors = { text: string; icon: string };

function Section({ title, colors, children }: { title: string; colors: ThemeColors; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.icon }]}>{title}</Text>
      {children}
    </View>
  );
}

// 긴 값(UUID·토큰)은 라벨 아래 줄에 고정폭으로
function Field({ label, value, colors }: { label: string; value: string | null | undefined; colors: ThemeColors }) {
  return (
    <View style={styles.field}>
      <Text style={[styles.rowLabel, { color: colors.icon }]}>{label}</Text>
      <Text style={[styles.mono, { color: colors.text }]} selectable>
        {value || "없음"}
      </Text>
    </View>
  );
}

function Row({ label, value, colors }: { label: string; value: string; colors: ThemeColors }) {
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
  body: { padding: 16, gap: 20, paddingBottom: 32 },
  pager: { flexDirection: "row", alignItems: "center" },
  pageBtn: { paddingHorizontal: 12, paddingVertical: 4 },
  pageArrow: { fontSize: 28, lineHeight: 32 },
  disabled: { opacity: 0.25 },
  pageCenter: { flex: 1, alignItems: "center", gap: 2 },
  name: { fontSize: 16, fontWeight: "700" },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.8 },
  card: { borderRadius: 14, padding: 16, gap: 10 },
  field: { gap: 2 },
  mono: { fontSize: 12, fontFamily: "monospace" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  rowLabel: { fontSize: 13 },
  rowValue: { fontSize: 13, fontWeight: "600", flexShrink: 1, textAlign: "right" },
  hint: { fontSize: 12, lineHeight: 18 },
  error: { fontSize: 12, color: "#ef4444" },
  secondaryBtn: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  secondaryText: { fontSize: 14, fontWeight: "600" },
  mapCard: { height: 260, borderRadius: 14, overflow: "hidden" },
  map: { flex: 1 },
  hidden: { height: 0, opacity: 0 },
  noLocation: { flex: 1, alignItems: "center", justifyContent: "center" },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: "70%",
  },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  modalActions: { flexDirection: "row", alignItems: "center", gap: 12 },
  modalTitle: { fontWeight: "700", fontSize: 16 },
  modalClose: { fontSize: 20, paddingHorizontal: 4 },
  smallBtn: { backgroundColor: "#16a34a", borderRadius: 8, paddingVertical: 6, paddingHorizontal: 12, minWidth: 72, alignItems: "center" },
  smallBtnText: { color: "#fff", fontSize: 13, fontWeight: "600" },
  logItem: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    gap: 2,
  },
  logTimestamp: { fontSize: 11 },
  logMessage: { fontSize: 12 },
  logType: { fontSize: 11, fontWeight: "600" },
  logEmpty: { textAlign: "center", marginTop: 24 },
});
