import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { loadDevices } from "@/lib/api/devices";
import { CURRENT_LOCATION_KEY } from "@/lib/constants";
import { readLogs } from "@/lib/system-log";
import { getTokenSecure } from "@/lib/token-storage";
import { LocationObject } from "expo-location";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { WebView } from "react-native-webview";

type DeviceLocation = {
  device_uuid: string;
  location: { latitude: number; longitude: number; range_meter: number };
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

    function addDeviceMarkers(devices) {
      deviceLayers.forEach(function(l) { map.removeLayer(l); });
      deviceLayers = [];
      devices.forEach(function(d) {
        var label = d.device_uuid.substring(0, 6);
        var lat = d.location.latitude;
        var lon = d.location.longitude;
        var range = d.location.range_meter;
        var icon = L.divIcon({
          className: '',
          html: '<div style="background:#E53935;color:#fff;padding:2px 5px;border-radius:4px;font-size:11px;white-space:nowrap;">' + label + '</div>',
          iconAnchor: [18, 8]
        });
        var m = L.marker([lat, lon], { icon: icon }).addTo(map).bindPopup(d.device_uuid);
        var c = L.circle([lat, lon], { radius: range, color: '#E53935', fillOpacity: 0.1 }).addTo(map);
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
  const [devices, setDevices] = useState<DeviceLocation[]>([]);

  const [showTimeline, setShowTimeline] = useState(false);
  const [gpsData, setGpsData] = useState<Record<string, GpsPoint[]>>({});
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const availableDates = Object.keys(gpsData).sort().reverse();

  useEffect(() => {
    const poll = setInterval(async () => {
      const raw = await getTokenSecure(CURRENT_LOCATION_KEY);
      if (raw) setUserLocation(JSON.parse(raw));
    }, 1000);
    return () => clearInterval(poll);
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
      void loadDevices().then(setDevices);
    }, []),
  );

  useEffect(() => {
    if (!mapReadyRef.current || devices.length === 0) return;
    webViewRef.current?.injectJavaScript(`addDeviceMarkers(${JSON.stringify(devices)}); true;`);
  }, [devices]);

  useEffect(() => {
    if (!userLocation || !mapReadyRef.current) return;
    const lat = parseFloat(String(userLocation.coords.latitude));
    const lon = parseFloat(String(userLocation.coords.longitude));
    const accuracy = (userLocation.coords.accuracy as any) ?? 0;
    webViewRef.current?.injectJavaScript(`updatePosition(${lat}, ${lon}, ${accuracy}); true;`);
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
