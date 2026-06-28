import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { fetchDeviceLocation, loadDevices } from "@/lib/api/devices";
import { UNFIGURED_DEVICES_KEY } from "@/lib/constants";
import { getTokenSecure } from "@/lib/token-storage";
import type { IoTDevice } from "@/lib/types";
import { Toast } from "@ant-design/react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

const mapHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { width: 100%; height: 100%; overflow: hidden; background: #f5f5f5; }
    #map { width: 100%; height: 100%; }

    #panel {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      background: #fff;
      padding: 16px 20px 32px;
      border-radius: 20px 20px 0 0;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.15);
      transform: translateY(110%);
      transition: transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
      z-index: 1000;
    }
    #panel.visible { transform: translateY(0); }

    #panel-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    #panel-title {
      font-size: 14px;
      font-weight: 700;
      color: #222;
    }
    #confirm-btn {
      padding: 7px 18px;
      border-radius: 20px;
      background: #4285F4;
      border: none;
      color: #fff;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }
    #panel-hint {
      font-size: 12px;
      color: #888;
      margin-bottom: 6px;
    }
    #panel-warning {
      font-size: 11px;
      color: #F57C00;
      margin-bottom: 14px;
    }

    .slider-row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .range-label {
      font-size: 11px;
      color: #aaa;
      white-space: nowrap;
    }
    #range-slider {
      flex: 1;
      -webkit-appearance: none;
      appearance: none;
      height: 6px;
      border-radius: 3px;
      background: linear-gradient(to right, #4285F4 0%, #4285F4 var(--val, 14%), #e0e0e0 var(--val, 14%));
      outline: none;
    }
    #range-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: #4285F4;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(66,133,244,0.45);
    }
    #range-val {
      font-size: 15px;
      font-weight: 700;
      color: #4285F4;
      min-width: 46px;
      text-align: right;
    }

    #hint-overlay {
      position: fixed;
      top: 14px; left: 50%;
      transform: translateX(-50%);
      background: rgba(0,0,0,0.6);
      color: #fff;
      font-size: 13px;
      padding: 8px 18px;
      border-radius: 20px;
      z-index: 1000;
      pointer-events: none;
      white-space: nowrap;
      transition: opacity 0.3s;
    }
    #hint-overlay.hidden { opacity: 0; }

    .device-label {
      background: rgba(30,30,30,0.72);
      color: #fff;
      border: none;
      border-radius: 5px;
      font-size: 11px;
      padding: 2px 7px;
      box-shadow: none;
      white-space: nowrap;
    }
    .leaflet-tooltip-top.device-label::before { border-top-color: rgba(30,30,30,0.72); }
  </style>
</head>
<body>
  <div id="map"></div>
  <div id="hint-overlay">지도를 눌러 위치를 선택하세요</div>

  <div id="panel">
    <div id="panel-header">
      <div id="panel-title">감지 범위</div>
      <button id="confirm-btn" onclick="onConfirm()">확인</button>
    </div>
    <div id="panel-hint">핀을 다시 눌러 위치를 변경할 수 있습니다</div>
    <div id="panel-warning">⚠ 범위가 넓을수록 배터리 소모가 커질 수 있습니다</div>
    <div class="slider-row">
      <span class="range-label">15m</span>
      <input id="range-slider" type="range" min="15" max="100" value="30" />
      <span class="range-label">100m</span>
      <span id="range-val">30m</span>
    </div>
  </div>

  <script>
    var map = L.map('map', { zoomControl: false }).setView([37.5665, 126.9780], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '\\u00a9 OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);

    var pin = null;
    var circle = null;
    var currentRange = 30;

    function updateSliderTrack(val) {
      var pct = ((val - 15) / (100 - 15) * 100).toFixed(1) + '%';
      document.getElementById('range-slider').style.setProperty('--val', pct);
    }
    updateSliderTrack(30);

    function notifyNative() {
      if (!pin || !window.ReactNativeWebView) return;
      var ll = pin.getLatLng();
      window.ReactNativeWebView.postMessage(JSON.stringify({
        lat: ll.lat, lng: ll.lng, range: currentRange
      }));
    }

    function placePin(latlng) {
      if (pin) {
        pin.setLatLng(latlng);
        circle.setLatLng(latlng);
      } else {
        var icon = L.divIcon({
          className: '',
          html: '<div style="width:18px;height:18px;border-radius:50%;background:#4285F4;border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.35);"></div>',
          iconAnchor: [9, 9]
        });
        pin = L.marker(latlng, { icon: icon, draggable: true }).addTo(map);
        circle = L.circle(latlng, {
          radius: currentRange,
          color: '#4285F4',
          fillColor: '#4285F4',
          fillOpacity: 0.12,
          weight: 2
        }).addTo(map);
        pin.on('drag', function(e) {
          circle.setLatLng(e.latlng);
        });
        pin.on('dragend', function() {
          notifyNative();
        });
        var panelEl = document.getElementById('panel');
        var panelHeight = panelEl.offsetHeight;
        panelEl.classList.add('visible');
        document.getElementById('hint-overlay').classList.add('hidden');
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'panel', height: panelHeight
        }));
      }
      notifyNative();
    }

    function onConfirm() {
      if (!pin || !window.ReactNativeWebView) return;
      var ll = pin.getLatLng();
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'confirm', lat: ll.lat, lng: ll.lng, range: currentRange
      }));
    }

    map.on('click', function(e) {
      placePin(e.latlng);
    });

    function goToLocation(lat, lng) {
      var latlng = L.latLng(lat, lng);
      map.setView(latlng, 16);
      placePin(latlng);
    }

    function addExistingDevices(devices) {
      devices.forEach(function(d) {
        if (!d.location) return;
        var label = d.device_nickname || d.device_uuid.substring(0, 8) + '...';
        var icon = L.divIcon({
          className: '',
          html: '<div style="width:13px;height:13px;border-radius:50%;background:#6B7280;border:2.5px solid #fff;box-shadow:0 1px 5px rgba(0,0,0,0.3);"></div>',
          iconAnchor: [6, 6]
        });
        L.marker([d.location.latitude, d.location.longitude], { icon: icon, interactive: false })
          .addTo(map)
          .bindTooltip(label, { permanent: true, direction: 'top', offset: [0, -6], className: 'device-label' });
        L.circle([d.location.latitude, d.location.longitude], {
          radius: d.location.range_meter,
          color: '#6B7280',
          fillColor: '#6B7280',
          fillOpacity: 0.08,
          weight: 1.5,
          interactive: false
        }).addTo(map);
      });
    }

    var slider = document.getElementById('range-slider');
    slider.addEventListener('input', function() {
      currentRange = parseInt(this.value);
      document.getElementById('range-val').textContent = currentRange + 'm';
      updateSliderTrack(currentRange);
      if (circle) circle.setRadius(currentRange);
      notifyNative();
    });
  </script>
</body>
</html>
`;

const BTN_BOTTOM_DEFAULT = 24;

export default function LocationSetupScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const isDark = colorScheme === "dark";
  const webViewRef = useRef<WebView>(null);
  const btnBottom = useRef(new Animated.Value(BTN_BOTTOM_DEFAULT)).current;
  const mapReadyRef = useRef(false);
  const existingDevicesRef = useRef<IoTDevice[]>([]);

  const [targetDevice, setTargetDevice] = useState<{ device_uuid: string } | null>(null);
  const [pendingLocation, setPendingLocation] = useState<{ lat: number; lng: number; range: number } | null>(null);
  const [nicknameVisible, setNicknameVisible] = useState(false);
  const [nickname, setNickname] = useState("");

  const onConfirm = async (_lat: number, _lng: number, _range: number, _nickname: string) => {
    if (!targetDevice) return;
    const result = await fetchDeviceLocation(targetDevice.device_uuid, _lat, _lng, _range, _nickname);
    if (result!.type === "success") Toast.info("위치 등록 성공");
  };

  const handleNicknameConfirm = async () => {
    if (!nickname.trim() || !pendingLocation) return;
    setNicknameVisible(false);
    await onConfirm(pendingLocation.lat, pendingLocation.lng, pendingLocation.range, nickname.trim());
    setNickname("");
    setPendingLocation(null);
  };

  const onMessage = (event: { nativeEvent: { data: string } }) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);
      if (data.type === "panel") {
        Animated.timing(btnBottom, {
          toValue: (data.height ?? 140) + BTN_BOTTOM_DEFAULT,
          duration: 300,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }).start();
      } else if (data.type === "confirm") {
        setPendingLocation({ lat: data.lat, lng: data.lng, range: data.range });
        setNicknameVisible(true);
      }
    } catch {}
  };

  const injectExistingDevices = () => {
    if (!mapReadyRef.current || existingDevicesRef.current.length === 0) return;
    const json = JSON.stringify(existingDevicesRef.current);
    webViewRef.current?.injectJavaScript(`addExistingDevices(${json}); true;`);
  };

  const handleLocate = async () => {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return;
    const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    const { latitude, longitude } = loc.coords;
    webViewRef.current?.injectJavaScript(`goToLocation(${latitude}, ${longitude}); true;`);
  };

  useEffect(() => {
    void (async () => {
      const devices = await loadDevices();
      existingDevicesRef.current = devices.filter((d) => d.location);
    })();
  }, []);

  useEffect(() => {
    void (async () => {
      const target_device = await getTokenSecure(UNFIGURED_DEVICES_KEY);
      if (!target_device) {
        router.push("/home");
        return;
      }
      const parsed_target_device = JSON.parse(target_device);
      const location_devices = parsed_target_device.filter((d: any) => d.type == "location");
      if (location_devices.length == 0) {
        router.push("/home");
        return;
      }
      setTargetDevice(location_devices[0]);
    })();
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={[styles.titleBar, { backgroundColor: colors.background, borderBottomColor: isDark ? "#2a2d2e" : "#eee" }]}>
        <Text style={[styles.titleText, { color: colors.text }]}>위치 설정</Text>
        {targetDevice && (
          <Text style={[styles.titleSub, { color: colors.icon }]} numberOfLines={1}>{targetDevice.device_uuid}</Text>
        )}
      </View>
      <WebView
        ref={webViewRef}
        source={{ html: mapHTML }}
        style={styles.map}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={["*"]}
        onMessage={onMessage}
        onLoad={() => {
          mapReadyRef.current = true;
          injectExistingDevices();
        }}
      />
      <Animated.View style={[styles.locateBtn, { bottom: btnBottom, backgroundColor: isDark ? "#1e2022" : "#fff" }]}>
        <TouchableOpacity style={styles.locateBtnInner} onPress={handleLocate}>
          <Ionicons name="locate" size={22} color="#4285F4" />
        </TouchableOpacity>
      </Animated.View>

      <Modal visible={nicknameVisible} transparent animationType="fade" onRequestClose={() => setNicknameVisible(false)}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <Pressable style={styles.modalBackdrop} onPress={() => setNicknameVisible(false)}>
          <Pressable style={[styles.modalBox, { backgroundColor: isDark ? "#1e2022" : "#fff" }]}>
            <Text style={[styles.modalTitle, { color: colors.text }]}>기기 별명</Text>
            <TextInput
              style={[styles.modalInput, { backgroundColor: isDark ? "#2A2D31" : "#F8FAFC", borderColor: isDark ? "#2C3237" : "#E2E8F0", color: colors.text }]}
              value={nickname}
              onChangeText={setNickname}
              placeholder="기기 별명을 입력하세요 (최대 20자)"
              placeholderTextColor={colors.icon}
              maxLength={20}
              autoFocus
            />
            <View style={styles.modalFooter}>
              <TouchableOpacity style={[styles.modalBtnSecondary, { backgroundColor: isDark ? "#2a2d2e" : "#F3F4F6" }]} onPress={() => setNicknameVisible(false)}>
                <Text style={[styles.modalBtnSecondaryText, { color: colors.icon }]}>취소</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalBtnPrimary, !nickname.trim() && styles.modalBtnDisabled]}
                onPress={handleNicknameConfirm}
                disabled={!nickname.trim()}
              >
                <Text style={styles.modalBtnPrimaryText}>확인</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  titleBar: {
    justifyContent: "center",
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  titleText: {
    fontSize: 17,
    fontWeight: "700",
  },
  titleSub: {
    fontSize: 11,
    marginTop: 2,
    fontFamily: "monospace",
  },
  map: { flex: 1 },
  locateBtn: {
    position: "absolute",
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 5,
  },
  locateBtnInner: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    alignItems: "center",
    padding: 24,
  },
  modalBox: {
    width: "100%",
    borderRadius: 20,
    padding: 24,
    gap: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 10,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  modalInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  modalFooter: {
    flexDirection: "row",
    gap: 10,
  },
  modalBtnSecondary: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
  },
  modalBtnSecondaryText: {
    fontSize: 15,
    fontWeight: "600",
  },
  modalBtnPrimary: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "#4285F4",
  },
  modalBtnDisabled: {
    backgroundColor: "#9CA3AF",
  },
  modalBtnPrimaryText: {
    fontSize: 15,
    fontWeight: "700",
    color: "#fff",
  },
});
