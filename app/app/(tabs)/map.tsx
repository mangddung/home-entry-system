import { CustomAlert } from "@/components/custom-alert";
import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { loadDevices } from "@/lib/api/devices";
import { userTokenExchange } from "@/lib/ble";
import { GEOFENCE_RADIUS_M, SELECTED_DEVICE_KEY } from "@/lib/constants";
import { noteManualUnlock } from "@/lib/proximity";
import { isTokenUsableNow } from "@/lib/schedule";
import { readLogs } from "@/lib/system-log";
import { setTokenSecure } from "@/lib/token-storage";
import type { IoTDevice } from "@/lib/types";
import * as Location from "expo-location";
import { LocationObject } from "expo-location";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

type DeviceLocation = {
  device_uuid: string;
  device_nickname: string | null;
  location: { latitude: number; longitude: number };
  usable: boolean; // 지금 인증 가능한 토큰 보유 여부 (상세 사유는 기기 상세 화면에서)
};

type GpsPoint = {
  timestamp: string;
  lat: number;
  lon: number;
  status: string;
};

function parseGpsLogs(raw: string): Record<string, GpsPoint[]> {
  const byDate: Record<string, GpsPoint[]> = {};
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    if (!line.includes("[GPS]")) continue;
    const tsMatch = line.match(/^\[(\d{2}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\]/);
    const latMatch = line.match(/latitude: ([\d.-]+)/);
    const lonMatch = line.match(/longtiude: ([\d.-]+)/);
    const statusMatch = line.match(/status: (\w+)/);
    if (!tsMatch || !latMatch || !lonMatch) continue;
    const date = tsMatch[1];
    const time = tsMatch[2];
    const point: GpsPoint = {
      timestamp: `${date} ${time}`,
      lat: parseFloat(latMatch[1]),
      lon: parseFloat(lonMatch[1]),
      status: statusMatch?.[1] ?? "unknown",
    };
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(point);
  }
  return byDate;
}

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
    #locate-btn {
      position: absolute; bottom: 24px; right: 12px; z-index: 1000;
      width: 44px; height: 44px; border-radius: 22px;
      background: #fff; border: none; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      font-size: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
  </style>
</head>
<body>
  <div id="map"></div>
  <button id="locate-btn" onclick="goToCurrentPosition()">⊕</button>
  <script>
    var map = L.map('map').setView([37.5665, 126.9780], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    var marker = null;
    var circle = null;
    var deviceLayers = [];
    var timelineLayers = [];
    var currentLat = null, currentLon = null;

    function esc(s) {
      return String(s).replace(/[&<>"']/g, function(c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function post(msg) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }

    // 팝업: 기기 이름(탭 → 상세), 사용 가능 여부, 사용 가능하면 문 열기 버튼.
    // 이름은 textContent로만 넣는다(HTML 해석 안 됨).
    function devicePopup(d, name) {
      var box = document.createElement('div');
      box.style.cssText = 'min-width:150px;font-size:13px;';
      var title = document.createElement('div');
      title.textContent = name;
      title.style.cssText = 'font-weight:700;color:#1a73e8;text-decoration:underline;cursor:pointer;margin-bottom:4px;';
      title.onclick = function() { post({ type: 'detail', uuid: d.device_uuid }); };
      var status = document.createElement('div');
      status.textContent = d.usable ? '● 사용 가능' : '○ 사용 불가';
      status.style.cssText = 'color:' + (d.usable ? '#16a34a' : '#6b7280') + ';';
      box.appendChild(title);
      box.appendChild(status);
      if (d.usable) {
        var btn = document.createElement('button');
        btn.textContent = '문 열기';
        btn.style.cssText = 'width:100%;margin-top:8px;padding:8px 0;border:none;border-radius:6px;background:#16a34a;color:#fff;font-size:13px;font-weight:600;';
        btn.onclick = function() { post({ type: 'unlock', uuid: d.device_uuid }); };
        box.appendChild(btn);
      }
      return box;
    }

    function addDeviceMarkers(devices) {
      deviceLayers.forEach(function(l) { map.removeLayer(l); });
      deviceLayers = [];
      devices.forEach(function(d) {
        var name = d.device_nickname || d.device_uuid.substring(0, 8) + '...';
        var label = esc(name);
        var color = d.usable ? '#16a34a' : '#9CA3AF';
        var lat = d.location.latitude;
        var lon = d.location.longitude;
        var range = ${GEOFENCE_RADIUS_M};
        var icon = L.divIcon({
          className: '',
          html: '<div style="background:' + color + ';color:#fff;padding:2px 5px;border-radius:4px;font-size:11px;white-space:nowrap;">' + label + '</div>',
          iconAnchor: [18, 8]
        });
        var m = L.marker([lat, lon], { icon: icon }).addTo(map).bindPopup(devicePopup(d, name));
        var c = L.circle([lat, lon], { radius: range, color: color, fillOpacity: 0.1 }).addTo(map);
        deviceLayers.push(m, c);
      });
    }

    function updatePosition(lat, lon, accuracy) {
      currentLat = lat; currentLon = lon;
      if (marker) {
        marker.setLatLng([lat, lon]);
      } else {
        marker = L.marker([lat, lon]).addTo(map).bindPopup('현재 위치').openPopup();
      }
      if (accuracy > 0) {
        if (circle) {
          circle.setLatLng([lat, lon]).setRadius(accuracy);
        } else {
          circle = L.circle([lat, lon], { radius: accuracy, color: '#4285F4', fillOpacity: 0.15 }).addTo(map);
        }
      }
    }

    function centerToCurrentPosition(lat, lon) {
      map.setView([lat, lon], 15);
    }

    function goToCurrentPosition() {
      if (currentLat !== null) map.setView([currentLat, currentLon], 15);
    }

    function clearTimeline() {
      timelineLayers.forEach(function(l) { map.removeLayer(l); });
      timelineLayers = [];
    }

    function drawTimeline(points) {
      clearTimeline();
      if (!points || points.length === 0) return;
      var latlngs = points.map(function(p) { return [p.lat, p.lon]; });

      var line = L.polyline(latlngs, { color: '#4285F4', weight: 5, opacity: 0.85 }).addTo(map);
      timelineLayers.push(line);

      // Intermediate dots (every Nth point to avoid clutter)
      var step = Math.max(1, Math.floor(points.length / 20));
      for (var i = step; i < points.length - 1; i += step) {
        var dot = L.circleMarker([points[i].lat, points[i].lon], {
          radius: 4, color: '#4285F4', fillColor: '#fff', fillOpacity: 1, weight: 2
        }).addTo(map).bindPopup(points[i].timestamp + '<br>활동: ' + points[i].status);
        timelineLayers.push(dot);
      }

      var startIcon = L.divIcon({
        className: '',
        html: '<div style="width:16px;height:16px;border-radius:50%;background:#34A853;border:3px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.4)"></div>',
        iconAnchor: [8, 8]
      });
      var endIcon = L.divIcon({
        className: '',
        html: '<div style="width:16px;height:16px;border-radius:50%;background:#EA4335;border:3px solid #fff;box-shadow:0 2px 5px rgba(0,0,0,0.4)"></div>',
        iconAnchor: [8, 8]
      });

      var startM = L.marker(latlngs[0], { icon: startIcon }).addTo(map)
        .bindPopup('출발: ' + points[0].timestamp);
      var endM = L.marker(latlngs[latlngs.length - 1], { icon: endIcon }).addTo(map)
        .bindPopup('도착: ' + points[points.length - 1].timestamp);
      timelineLayers.push(startM, endM);

      map.fitBounds(line.getBounds(), { padding: [50, 50] });
    }
  </script>
</body>
</html>
`;

const MAP_SOURCE = { html: mapHTML };

export default function MapScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const colors = Colors[colorScheme ?? "light"];
  const [userLocation, setUserLocation] = useState<LocationObject | null>(null);
  const webViewRef = useRef<WebView>(null);
  const mapReadyRef = useRef(false);
  const centeredRef = useRef(false);
  const [devices, setDevices] = useState<DeviceLocation[]>([]);
  const fullDevicesRef = useRef<IoTDevice[]>([]);
  const [unlocking, setUnlocking] = useState(false);
  const unlockingRef = useRef(false);
  const [alertConfig, setAlertConfig] = useState<{ title: string; message?: string } | null>(null);
  const showAlert = (title: string, message?: string) => setAlertConfig({ title, message });

  const [showTimeline, setShowTimeline] = useState(false);
  const [gpsData, setGpsData] = useState<Record<string, GpsPoint[]>>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const availableDates = Object.keys(gpsData).sort().reverse();

  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    void (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted" || cancelled) return;
      const last = await Location.getLastKnownPositionAsync();
      if (last && !cancelled) setUserLocation(last);
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, distanceInterval: 10, timeInterval: 5000 },
        (loc) => setUserLocation(loc),
      );
      if (cancelled) sub.remove();
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, []);

  const loadGpsData = useCallback(() => {
    const raw = readLogs();
    const parsed = parseGpsLogs(raw);
    setGpsData(parsed);
    const dates = Object.keys(parsed).sort().reverse();
    if (dates.length > 0) setSelectedDate((prev) => prev ?? dates[0]);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadGpsData();
    }, [loadGpsData]),
  );

  useFocusEffect(
    useCallback(() => {
      void loadDevices().then((list) => {
        fullDevicesRef.current = list;
        setDevices(
          list
            .filter((d) => !!d.location)
            .map((d) => ({
              device_uuid: d.device_uuid,
              device_nickname: d.device_nickname,
              location: d.location!,
              usable: isTokenUsableNow(d.auth_token),
            })),
        );
      });
    }, []),
  );

  // 지도 팝업에서 온 요청: 기기 상세 이동 / 수동 인증
  const onMapMessage = async (e: WebViewMessageEvent) => {
    let msg: { type?: string; uuid?: string };
    try {
      msg = JSON.parse(e.nativeEvent.data);
    } catch {
      return;
    }
    const device = fullDevicesRef.current.find((d) => d.device_uuid === msg.uuid);
    if (!device) return;

    if (msg.type === "detail") {
      await setTokenSecure(SELECTED_DEVICE_KEY, JSON.stringify(device));
      router.push("/device/device_info");
      return;
    }
    if (msg.type !== "unlock" || unlockingRef.current) return;
    // 팝업은 화면 진입 시점 기준이라 누른 시점에 다시 확인한다
    if (!isTokenUsableNow(device.auth_token)) {
      showAlert("사용 불가", "지금은 이 기기를 열 수 없습니다. 기기 상세에서 키 상태를 확인하세요.");
      return;
    }
    unlockingRef.current = true;
    setUnlocking(true);
    // 자동 해제를 기다리다 직접 연 경우면 "늦음" 피드백으로 반영
    void noteManualUnlock(device);
    try {
      const success = await userTokenExchange(device);
      if (success) {
        showAlert("수동 인증", "인증 요청을 보냈습니다.");
      } else {
        showAlert("오류", "기기에 연결할 수 없습니다. 기기가 오프라인 상태이거나 범위 밖에 있는지 확인하세요.");
      }
    } catch {
      showAlert("오류", "인증 중 오류가 발생했습니다.");
    } finally {
      unlockingRef.current = false;
      setUnlocking(false);
    }
  };

  useEffect(() => {
    if (!mapReadyRef.current || devices.length === 0) return;
    webViewRef.current?.injectJavaScript(`addDeviceMarkers(${JSON.stringify(devices)}); true;`);
  }, [devices]);

  useEffect(() => {
    if (!userLocation || !mapReadyRef.current) return;
    const lat = parseFloat(String(userLocation.coords.latitude));
    const lon = parseFloat(String(userLocation.coords.longitude));
    const accuracy = (userLocation.coords.accuracy as any) ?? 0;
    const center = centeredRef.current ? "" : `centerToCurrentPosition(${lat}, ${lon});`;
    // 캐시된 부정확한 좌표(첫 last-known)에 화면이 고정되지 않도록, 정확도가 확보된 뒤에만 센터링을 멈춘다
    centeredRef.current = accuracy > 0 && accuracy <= 100;
    webViewRef.current?.injectJavaScript(`updatePosition(${lat}, ${lon}, ${accuracy}); ${center} true;`);
  }, [userLocation]);

  useEffect(() => {
    if (!mapReadyRef.current) return;
    if (showTimeline && selectedDate && gpsData[selectedDate]) {
      const points = gpsData[selectedDate];
      webViewRef.current?.injectJavaScript(`drawTimeline(${JSON.stringify(points)}); true;`);
    } else {
      webViewRef.current?.injectJavaScript(`clearTimeline(); true;`);
    }
  }, [showTimeline, selectedDate, gpsData]);

  const onMapLoad = () => {
    mapReadyRef.current = true;
    if (devices.length > 0) {
      webViewRef.current?.injectJavaScript(`addDeviceMarkers(${JSON.stringify(devices)}); true;`);
    }
    if (userLocation) {
      const lat = parseFloat(String(userLocation.coords.latitude));
      const lon = parseFloat(String(userLocation.coords.longitude));
      const accuracy = userLocation.coords.accuracy ?? 0;
      centeredRef.current = true;
      webViewRef.current?.injectJavaScript(
        `updatePosition(${lat}, ${lon}, ${accuracy}); centerToCurrentPosition(${lat}, ${lon}); true;`,
      );
    }
    if (showTimeline && selectedDate && gpsData[selectedDate]) {
      webViewRef.current?.injectJavaScript(
        `drawTimeline(${JSON.stringify(gpsData[selectedDate])}); true;`,
      );
    }
  };

  const formatDateLabel = (d: string) => {
    // d: "yy-MM-dd" e.g. "26-04-28"
    const [, mm, dd] = d.split("-");
    const today = new Date();
    const todayStr = `${String(today.getFullYear()).slice(-2)}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yestStr = `${String(yesterday.getFullYear()).slice(-2)}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`;
    if (d === todayStr) return "오늘";
    if (d === yestStr) return "어제";
    return `${mm}/${dd}`;
  };

  return (
    <View style={{ flex: 1 }}>
      <WebView
        ref={webViewRef}
        source={MAP_SOURCE}
        style={styles.map}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={["*"]}
        onLoad={onMapLoad}
        onMessage={onMapMessage}
      />

      {unlocking && (
        <View style={styles.unlockOverlay}>
          <View style={[styles.unlockBox, { backgroundColor: isDark ? "#1E2124" : "#fff" }]}>
            <ActivityIndicator color="#16a34a" />
            <Text style={[styles.unlockText, { color: colors.text }]}>인증 중...</Text>
          </View>
        </View>
      )}

      <CustomAlert
        visible={!!alertConfig}
        title={alertConfig?.title ?? ""}
        message={alertConfig?.message}
        onRequestClose={() => setAlertConfig(null)}
      />

      {/* Timeline toggle button */}
      <TouchableOpacity
        style={[styles.timelineBtn, { backgroundColor: isDark ? "#1e2022" : "#fff" }, showTimeline && styles.timelineBtnActive]}
        onPress={() => setShowTimeline((v) => !v)}
      >
        <Text style={[styles.timelineBtnText, { color: colors.text }, showTimeline && styles.timelineBtnTextActive]}>
          타임라인
        </Text>
      </TouchableOpacity>

      {/* Timeline bottom panel */}
      {showTimeline && (
        <View style={styles.panel}>
          {availableDates.length === 0 ? (
            <Text style={styles.emptyText}>저장된 GPS 기록이 없습니다.</Text>
          ) : (
            <>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.dateRow}
              >
                {availableDates.map((date) => (
                  <TouchableOpacity
                    key={date}
                    style={[styles.dateChip, selectedDate === date && styles.dateChipActive]}
                    onPress={() => setSelectedDate(date)}
                  >
                    <Text
                      style={[
                        styles.dateChipText,
                        selectedDate === date && styles.dateChipTextActive,
                      ]}
                    >
                      {formatDateLabel(date)}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              {selectedDate && gpsData[selectedDate] && (
                <Text style={styles.countText}>
                  {gpsData[selectedDate].length}개 위치 기록 ·{" "}
                  {gpsData[selectedDate][0]?.timestamp.split(" ")[1]} ~{" "}
                  {gpsData[selectedDate][gpsData[selectedDate].length - 1]?.timestamp.split(" ")[1]}
                </Text>
              )}
            </>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  map: { flex: 1 },
  unlockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
    alignItems: "center",
    justifyContent: "center",
  },
  unlockBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderRadius: 12,
  },
  unlockText: {
    fontSize: 14,
    fontWeight: "600",
  },
  timelineBtn: {
    position: "absolute",
    top: 16,
    right: 16,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  timelineBtnActive: {
    backgroundColor: "#4285F4",
  },
  timelineBtnText: {
    fontSize: 13,
    fontWeight: "600",
  },
  timelineBtnTextActive: {
    color: "#fff",
  },
  panel: {
    backgroundColor: "#1a1a2e",
    paddingTop: 12,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: "#333",
  },
  dateRow: {
    gap: 8,
    paddingBottom: 10,
  },
  dateChip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: "#2a2a3e",
    borderWidth: 1,
    borderColor: "#444",
  },
  dateChipActive: {
    backgroundColor: "#4285F4",
    borderColor: "#4285F4",
  },
  dateChipText: {
    fontSize: 13,
    color: "#aaa",
    fontWeight: "500",
  },
  dateChipTextActive: {
    color: "#fff",
    fontWeight: "700",
  },
  countText: {
    fontSize: 12,
    color: "#888",
    marginTop: 2,
  },
  emptyText: {
    fontSize: 13,
    color: "#888",
    textAlign: "center",
    paddingVertical: 8,
  },
});
