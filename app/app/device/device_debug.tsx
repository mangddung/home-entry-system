import { fetchDevices } from "@/lib/api/devices";
import { userTokenExchange } from "@/lib/ble";
import { DEBUG_LOG, USER_DEVICES_KEY } from "@/lib/constants";
import { getTokenSecure } from "@/lib/token-storage";
import type { DebugLog, IoTDevice } from "@/lib/types";
import { Button, Provider, Text } from "@ant-design/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useState } from "react";
import { FlatList, Modal, StyleSheet, TouchableOpacity, View } from "react-native";
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
      var lat = d.latitude, lon = d.longitude, range = d.range_meter;
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

export default function DKeySettingScreen() {
  const [devices, setDevices] = useState<IoTDevice[]>([]);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const webViewRef = useRef<WebView>(null);
  const mapReadyRef = useRef(false);
  const [logModalVisible, setLogModalVisible] = useState(false);
  const [logs, setLogs] = useState<DebugLog[]>([]);

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

  const device: IoTDevice | null = devices[index] ?? null;

  useEffect(() => {
    void (async () => {
      const result = await fetchDevices();
      if (result.type !== "success") {
        setError(result.message);
      }
      const stored = await getTokenSecure(USER_DEVICES_KEY);
      if (stored) setDevices(JSON.parse(stored));
    })();
  }, []);

  const injectLocation = (loc: IoTDevice["location"]) => {
    if (!mapReadyRef.current || !loc) return;
    webViewRef.current?.injectJavaScript(`setDevice(${JSON.stringify(loc)}); true;`);
  };

  useEffect(() => {
    injectLocation(device?.location ?? null);
  }, [index, devices]);

  if (error && devices.length === 0) {
    return (
      <Provider>
        <Text style={styles.error}>{error}</Text>
      </Provider>
    );
  }

  if (!device) {
    return (
      <Provider>
        <Text style={styles.empty}>디바이스 없음</Text>
      </Provider>
    );
  }

  return (
    <Provider>
      <View style={styles.container}>
        <View style={styles.nav}>
          <Button disabled={index === 0} onPress={() => setIndex((i) => i - 1)}>
            ◀
          </Button>
          <Text style={styles.navLabel}>
            {index + 1} / {devices.length}
          </Text>
          <Button disabled={index === devices.length - 1} onPress={() => setIndex((i) => i + 1)}>
            ▶
          </Button>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>{device.device_uuid}</Text>
          <View style={styles.row}>
            <Text>역할: {device.role}</Text>
            <View style={styles.rowButtons}>
              <Button size="small" onPress={openLogModal}>
                디버그
              </Button>
            </View>
          </View>
          <View style={styles.divider} />
          <Text style={styles.sectionLabel}>BLE</Text>
          <Text>서비스 UUID: {device.ble_uuids.ble_service_uuid}</Text>
          <Text>쓰기 UUID: {device.ble_uuids.ble_write_uuid}</Text>
          <Text>읽기 UUID: {device.ble_uuids.ble_read_uuid}</Text>
          <Text>제조사 UUID: {device.ble_uuids.ble_manufacturer_uuid}</Text>
          {device.auth_token ? (
            <>
              <Text>토큰: {device.auth_token.token_value}</Text>
              <Text>
                max_uses: {device.auth_token.max_uses}, use_count: {device.auth_token.use_count}
              </Text>
              <Text>
                not_before:{" "}
                {device.auth_token.not_before
                  ? new Date(device.auth_token.not_before).toLocaleString()
                  : "없음"}
                , expired_at:{" "}
                {device.auth_token.expired_at
                  ? new Date(device.auth_token.expired_at).toLocaleString()
                  : "없음"}
              </Text>
            </>
          ) : (
            <Text>토큰: 없음</Text>
          )}
        </View>

        <WebView
          ref={webViewRef}
          source={{ html: mapHTML }}
          style={[styles.map, !device.location && styles.hidden]}
          javaScriptEnabled
          domStorageEnabled
          originWhitelist={["*"]}
          onLoad={() => {
            mapReadyRef.current = true;
            injectLocation(device.location);
          }}
        />
        {!device.location && (
          <View style={styles.noLocation}>
            <Text style={styles.noLocationText}>위치 정보 없음</Text>
          </View>
        )}
      </View>

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
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>디버그 로그</Text>
              <Button
                size="small"
                onPress={async () => {
                  await userTokenExchange(device);
                }}
              >
                토큰 전송
              </Button>
              <TouchableOpacity onPress={() => setLogModalVisible(false)}>
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {logs.length === 0 ? (
              <Text style={styles.logEmpty}>로그 없음</Text>
            ) : (
              <FlatList
                style={{ flexShrink: 1 }}
                data={logs}
                keyExtractor={(_, i) => String(i)}
                renderItem={({ item }) => (
                  <View style={styles.logItem}>
                    <Text style={styles.logTimestamp}>{item.timestamp}</Text>
                    <Text style={styles.logMessage}>
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
    </Provider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  navLabel: { fontSize: 16, fontWeight: "600" },
  card: {
    margin: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 8,
    gap: 4,
  },
  cardTitle: { fontWeight: "bold", fontSize: 13, marginBottom: 4 },
  divider: { height: 1, backgroundColor: "#e5e7eb", marginVertical: 6 },
  sectionLabel: { fontWeight: "600", color: "#6b7280", marginBottom: 2 },
  map: { flex: 1 },
  hidden: { height: 0, opacity: 0 },
  noLocation: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  noLocationText: { color: "#9ca3af", fontSize: 14 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  rowButtons: { flexDirection: "row", gap: 8 },
  error: { color: "red", padding: 12 },
  empty: { padding: 12, color: "#6b7280" },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    backgroundColor: "#fff",
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
  modalTitle: { fontWeight: "700", fontSize: 16 },
  modalClose: { fontSize: 20, color: "#6b7280", paddingHorizontal: 4 },
  logItem: {
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#f3f4f6",
    gap: 2,
  },
  logTimestamp: { fontSize: 11, color: "#9ca3af" },
  logMessage: { fontSize: 12, color: "#111827" },
  logType: { fontSize: 11, fontWeight: "600" },
  logEmpty: { textAlign: "center", color: "#9ca3af", marginTop: 24 },
});
