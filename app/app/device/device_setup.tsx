import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { fetchDeviceSetupToken, fetchSetupUuid, loadDevices } from "@/lib/api/devices";
import { connectDevice, receiveData, scanDevice, sendSetupCode, sendWifiSetup, stopScan, triggerPairing } from "@/lib/ble";
import NetInfo from "@react-native-community/netinfo";
import { DEVICE_SETUP_KEY, MAX_DEVICES_PER_USER, UNFIGURED_DEVICES_KEY } from "@/lib/constants";
import { getTokenSecure, setTokenSecure } from "@/lib/token-storage";
import { IoTDevice } from "@/lib/types";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { Device } from "react-native-ble-plx";
import { SafeAreaView } from "react-native-safe-area-context";

const TIMER_SECONDS = 180;
const SCAN_SECONDS = 30;

function getSignalInfo(rssi: number | null): { name: string; color: string } {
  if (rssi == null) return { name: "signal-cellular-outline", color: "#9E9E9E" };
  if (rssi > -65) return { name: "signal-cellular-3", color: "#4CAF50" };
  if (rssi > -80) return { name: "signal-cellular-2", color: "#FFC107" };
  return { name: "signal-cellular-1", color: "#F44336" };
}

function PulseRing({ color, delay }: { color: string; delay: number }) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, { toValue: 1, duration: 2000, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <Animated.View
      style={{
        position: "absolute",
        width: 88,
        height: 88,
        borderRadius: 44,
        borderWidth: 1.5,
        borderColor: color,
        transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 2.8] }) }],
        opacity: anim.interpolate({ inputRange: [0, 0.2, 1], outputRange: [0.6, 0.4, 0] }),
      }}
    />
  );
}

export default function DeviceSetupScreen() {
  const scheme = useColorScheme();
  const colors = Colors[scheme ?? "light"];
  const isDark = scheme === "dark";
  const cardBg = isDark ? "#1E2124" : "#F8FAFC";
  const cardBorder = isDark ? "#2C3237" : "#E2E8F0";

  const [timeLeft, setTimeLeft] = useState(TIMER_SECONDS);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [receivedNonce, setReceivedNonce] = useState("");
  const [setupCode, setSetupCode] = useState("");
  const [setupDevice, setSetupDevice] = useState<IoTDevice | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [connected, setConnected] = useState<Device | null>(null);
  const connectedRef = useRef<Device | null>(null);
  const disconnectIntentional = useRef(false);
  const [deviceUuid, setDeviceUuid] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [proccess, setProcces] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [isConnecting, setIsConnecting] = useState<string | null>(null);
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const [scanTimeLeft, setScanTimeLeft] = useState(SCAN_SECONDS);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    void (async () => {
      if ((await loadDevices()).length >= MAX_DEVICES_PER_USER) {
        Alert.alert("등록 제한", `기기는 최대 ${MAX_DEVICES_PER_USER}개까지 등록할 수 있습니다.`, [
          { text: "확인", onPress: () => router.back() },
        ]);
      }
    })();
  }, []);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  useEffect(() => {
    if (!connected) return;
    disconnectIntentional.current = false;
    const subscription = connected.onDisconnected(() => {
      if (disconnectIntentional.current) return;
      Alert.alert("연결 끊김", "기기와의 연결이 끊어졌습니다.", [
        { text: "확인", onPress: () => router.replace("/") },
      ]);
    });
    return () => subscription.remove();
  }, [connected]);

  const startScan = useCallback(async (ioTDevice: IoTDevice) => {
    setIsScanning(true);
    setScanTimeLeft(SCAN_SECONDS);
    setDevices([]);

    const timer = setInterval(() => {
      setScanTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    lastSeenRef.current.clear();
    const staleTimer = setInterval(() => {
      const now = Date.now();
      setDevices((prev) => prev.filter((d) => {
        const last = lastSeenRef.current.get(d.id);
        return last !== undefined && now - last < 3000;
      }));
    }, 1000);

    await scanDevice(ioTDevice, (device) => {
      lastSeenRef.current.set(device.id, Date.now());
      setDevices((prev) => {
        const exists = prev.some((d) => d.id === device.id);
        if (exists) {
          return prev.map((d) => (d.id === device.id ? device : d));
        }
        return [...prev, device].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
      });
    });

    clearInterval(staleTimer);
    clearInterval(timer);
    setIsScanning(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setProcces(0);
      void (async () => {
        await fetchSetupUuid();
        const raw = await getTokenSecure(DEVICE_SETUP_KEY);
        if (!raw) {
          Alert.alert("setup setupDevice fetch failed");
          return;
        }
        const parsedSetupDevice: IoTDevice = JSON.parse(raw);
        setSetupDevice(parsedSetupDevice);
        await startScan(parsedSetupDevice);
      })();

      return () => {
        stopScan();
        const device = connectedRef.current;
        if (device) {
          disconnectIntentional.current = true;
          connectedRef.current = null;
          setConnected(null);
          device.cancelConnection().catch(() => {});
        }
      };
    }, [startScan]),
  );

  // Wi-Fi SSID 자동 입력
  useEffect(() => {
    if (proccess !== 3) return;
    NetInfo.fetch("wifi").then((state) => {
      if (state.type === "wifi" && state.details?.ssid) {
        setWifiSsid(state.details.ssid);
      }
    });
  }, [proccess]);

  // 셋업 코드 입력 타이머
  useEffect(() => {
    if (!receivedNonce) return;
    setTimeLeft(TIMER_SECONDS);
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current!);
  }, [receivedNonce]);

  // setup 코드 입력 뷰
  if (proccess == 2) {
    const minutes = String(Math.floor(timeLeft / 60)).padStart(2, "0");
    const seconds = String(timeLeft % 60).padStart(2, "0");
    const isExpired = timeLeft === 0;
    const timerColor = isExpired || timeLeft <= 30 ? "#EF4444" : colors.tint;
    const timerBg =
      isExpired || timeLeft <= 30
        ? isDark
          ? "rgba(239,68,68,0.12)"
          : "#FEF2F2"
        : isDark
          ? "rgba(10,126,164,0.12)"
          : "#EFF8FC";
    const timerBorderColor =
      isExpired || timeLeft <= 30
        ? isDark
          ? "rgba(239,68,68,0.3)"
          : "#FECACA"
        : isDark
          ? "rgba(10,126,164,0.3)"
          : "#BAE6F7";

    return (
      <SafeAreaView
        style={[styles.formContainer, { backgroundColor: colors.background }]}
        edges={["top"]}
      >
        <View style={styles.pageHeaderRow}>
          <Text style={[styles.pageTitle, { color: colors.text }]}>기기 추가</Text>
          <View
            style={[
              styles.stepBadge,
              {
                backgroundColor: isDark ? "rgba(10,126,164,0.15)" : "#EFF8FC",
                borderColor: isDark ? "rgba(10,126,164,0.3)" : "#BAE6F7",
              },
            ]}
          >
            <Text style={[styles.stepText, { color: colors.tint }]}>2 / 3</Text>
          </View>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1, width: "100%" }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView
            contentContainerStyle={styles.formScroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* 히어로 */}
            <View style={styles.formHero}>
              <View
                style={[
                  styles.iconCircle,
                  {
                    backgroundColor: isDark ? "rgba(10,126,164,0.15)" : "#EFF8FC",
                    borderColor: isDark ? "rgba(10,126,164,0.3)" : "#BAE6F7",
                  },
                ]}
              >
                <MaterialCommunityIcons name="shield-lock-outline" size={38} color={colors.tint} />
              </View>
              <Text style={[styles.formTitle, { color: colors.text }]}>Setup 코드 입력</Text>
              <Text style={[styles.formSub, { color: colors.tabIconDefault }]}>
                기기에 표시된 코드를 입력해 주세요
              </Text>
            </View>

            {/* 타이머 배지 */}
            <View
              style={[
                styles.timerBadge,
                { backgroundColor: timerBg, borderColor: timerBorderColor },
              ]}
            >
              <MaterialCommunityIcons name="timer-outline" size={15} color={timerColor} />
              <Text style={[styles.timerBadgeText, { color: timerColor }]}>
                남은 시간　{minutes}:{seconds}
              </Text>
            </View>

            {/* 입력 필드 */}
            <View style={styles.formFields}>
              <View style={styles.fieldWrap}>
                <Text style={[styles.fieldLabel, { color: colors.tabIconDefault }]}>
                  Setup 코드
                </Text>
                <TextInput
                  style={[
                    styles.fieldInput,
                    { color: colors.text, backgroundColor: cardBg, borderColor: cardBorder },
                  ]}
                  value={setupCode}
                  onChangeText={setSetupCode}
                  placeholder="코드를 입력하세요"
                  placeholderTextColor={colors.tabIconDefault}
                  editable={!isExpired}
                />
              </View>
            </View>

            {/* 확인 버튼 */}
            <TouchableOpacity
              style={[
                styles.submitButton,
                {
                  backgroundColor: isExpired ? colors.tabIconDefault : "#3B82F6",
                  opacity: isSubmitting ? 0.7 : 1,
                },
              ]}
              disabled={isExpired || isSubmitting}
              onPress={async () => {
                setIsSubmitting(true);
                await sendSetupCode(connected, setupDevice!, receivedNonce, setupCode);
                const device_uuid = await receiveData(connected!, setupDevice!);
                setDeviceUuid(device_uuid!);
                const setup_token = await fetchDeviceSetupToken(device_uuid);
                setSetupToken(setup_token);
                setIsSubmitting(false);
                setProcces(3);
              }}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitText}>확인</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // 와이파이 정보 입력 뷰
  if (proccess == 3) {
    return (
      <SafeAreaView
        style={[styles.formContainer, { backgroundColor: colors.background }]}
        edges={["top"]}
      >
        <View style={styles.pageHeaderRow}>
          <Text style={[styles.pageTitle, { color: colors.text }]}>기기 추가</Text>
          <View
            style={[
              styles.stepBadge,
              {
                backgroundColor: isDark ? "rgba(10,126,164,0.15)" : "#EFF8FC",
                borderColor: isDark ? "rgba(10,126,164,0.3)" : "#BAE6F7",
              },
            ]}
          >
            <Text style={[styles.stepText, { color: colors.tint }]}>3 / 3</Text>
          </View>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1, width: "100%" }}
          behavior={Platform.OS === "ios" ? "padding" : "height"}
        >
          <ScrollView
            contentContainerStyle={styles.formScroll}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {/* 히어로 */}
            <View style={styles.formHero}>
              <View
                style={[
                  styles.iconCircle,
                  {
                    backgroundColor: isDark ? "rgba(10,126,164,0.15)" : "#EFF8FC",
                    borderColor: isDark ? "rgba(10,126,164,0.3)" : "#BAE6F7",
                  },
                ]}
              >
                <MaterialCommunityIcons name="wifi" size={38} color={colors.tint} />
              </View>
              <Text style={[styles.formTitle, { color: colors.text }]}>Wi-Fi 연결</Text>
              <Text style={[styles.formSub, { color: colors.tabIconDefault }]}>
                기기를 연결할 Wi-Fi 정보를 입력해 주세요
              </Text>
            </View>

            {/* 입력 필드 */}
            <View style={styles.formFields}>
              <View style={styles.fieldWrap}>
                <Text style={[styles.fieldLabel, { color: colors.tabIconDefault }]}>
                  Wi-Fi 이름 (SSID)
                </Text>
                <TextInput
                  style={[
                    styles.fieldInput,
                    { color: colors.text, backgroundColor: cardBg, borderColor: cardBorder },
                  ]}
                  value={wifiSsid}
                  onChangeText={setWifiSsid}
                  placeholder="이름을 입력하세요"
                  placeholderTextColor={colors.tabIconDefault}
                  autoCapitalize="none"
                />
              </View>

              <View style={styles.fieldWrap}>
                <Text style={[styles.fieldLabel, { color: colors.tabIconDefault }]}>비밀번호</Text>
                <View
                  style={[
                    styles.passwordWrap,
                    { backgroundColor: cardBg, borderColor: cardBorder },
                  ]}
                >
                  <TextInput
                    style={[styles.passwordInput, { color: colors.text }]}
                    value={wifiPassword}
                    onChangeText={setWifiPassword}
                    placeholder="비밀번호를 입력하세요"
                    placeholderTextColor={colors.tabIconDefault}
                    secureTextEntry={!showPassword}
                    autoCapitalize="none"
                  />
                  <TouchableOpacity
                    onPress={() => setShowPassword((v) => !v)}
                    style={styles.eyeButton}
                  >
                    <MaterialCommunityIcons
                      name={showPassword ? "eye-off-outline" : "eye-outline"}
                      size={20}
                      color={colors.tabIconDefault}
                    />
                  </TouchableOpacity>
                </View>
              </View>
            </View>

            {/* 연결 버튼 */}
            <TouchableOpacity
              style={[
                styles.submitButton,
                { backgroundColor: "#3B82F6", opacity: isSubmitting ? 0.7 : 1 },
              ]}
              disabled={isSubmitting}
              onPress={async () => {
                setIsSubmitting(true);
                await sendWifiSetup(connected, setupDevice!, wifiSsid, wifiPassword, setupToken);
                const receiveResponse = await receiveData(connected!, setupDevice!);
                if (receiveResponse != "ACK") {
                  console.log("not received");
                }
                const apiResponse = await receiveData(connected!, setupDevice!);
                setIsSubmitting(false);
                if (apiResponse == "REGISTERED") {
                  const device = [{ device_uuid: deviceUuid, type: "location" }];
                  await setTokenSecure(UNFIGURED_DEVICES_KEY, JSON.stringify(device));
                  router.push("/device/location-setup");
                }
              }}
            >
              {isSubmitting ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.submitText}>연결</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  // 스캔 뷰
  if (setupDevice) {
    const scanSecs = String(scanTimeLeft % 60).padStart(2, "0");
    const scanMins = String(Math.floor(scanTimeLeft / 60)).padStart(2, "0");

    return (
      <SafeAreaView
        style={[styles.scanContainer, { backgroundColor: colors.background }]}
        edges={["top"]}
      >
        <View style={styles.pageHeader}>
          <Text style={[styles.pageTitle, { color: colors.text }]}>기기 추가</Text>
        </View>

        <View style={styles.scanHero}>
          <View style={styles.iconWrap}>
            {isScanning && (
              <>
                <PulseRing color={colors.tint} delay={0} />
                <PulseRing color={colors.tint} delay={700} />
                <PulseRing color={colors.tint} delay={1400} />
              </>
            )}
            <View
              style={[
                styles.iconCircle,
                {
                  backgroundColor: isDark ? "rgba(10,126,164,0.15)" : "#EFF8FC",
                  borderColor: isDark ? "rgba(10,126,164,0.3)" : "#BAE6F7",
                },
              ]}
            >
              <MaterialCommunityIcons
                name={
                  (isConnecting
                    ? "bluetooth-connect"
                    : isScanning
                      ? "bluetooth"
                      : devices.length > 0
                        ? "bluetooth-connect"
                        : "bluetooth-off") as any
                }
                size={38}
                color={colors.tint}
              />
            </View>
          </View>

          <View style={styles.statusTextWrap}>
            <Text style={[styles.statusTitle, { color: colors.text }]}>
              {isConnecting
                ? "기기와 보안 연결 중..."
                : isScanning
                  ? "주변 기기를 스캔하고 있습니다"
                  : devices.length > 0
                    ? "스캔 완료"
                    : "기기를 찾지 못했습니다"}
            </Text>
            <Text style={[styles.statusSub, { color: colors.tabIconDefault }]}>
              {isConnecting
                ? "블루투스 페어링 팝업이 나타나면 '확인'을 눌러주세요"
                : isScanning
                  ? "기기의 전원이 켜져 있는지 확인해 주세요"
                  : devices.length > 0
                    ? "연결할 기기를 선택하세요"
                    : "기기를 켜고 재스캔을 시도해 주세요"}
            </Text>
          </View>

          {isConnecting ? (
            <ActivityIndicator color={colors.tint} />
          ) : isScanning ? (
            <View style={styles.timerWrap}>
              <Text
                style={[
                  styles.timerValue,
                  { color: scanTimeLeft <= 10 ? "#EF4444" : colors.tabIconDefault },
                ]}
              >
                {scanMins}:{scanSecs}
              </Text>
            </View>
          ) : (
            <TouchableOpacity
              style={[styles.rescanButton, { borderColor: colors.tint }]}
              onPress={() => startScan(setupDevice)}
            >
              <MaterialCommunityIcons name="refresh" size={18} color={colors.tint} />
              <Text style={[styles.rescanText, { color: colors.tint }]}>재스캔</Text>
            </TouchableOpacity>
          )}
        </View>

        {(devices.length > 0 || !isScanning) && (
          <View style={[styles.listDivider, { borderTopColor: cardBorder }]}>
            <Text style={[styles.listHeader, { color: colors.tabIconDefault }]}>
              {devices.length > 0 ? `발견된 기기 ${devices.length}개` : "발견된 기기 없음"}
            </Text>
          </View>
        )}

        <ScrollView
          style={{ flex: 1, width: "100%" }}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 24, gap: 10 }}
          showsVerticalScrollIndicator={false}
        >
          {devices.map((d) => {
            const signal = getSignalInfo(d.rssi);
            const isThisConnecting = isConnecting === d.id;
            return (
              <TouchableOpacity
                key={d.id}
                activeOpacity={0.7}
                style={[
                  styles.deviceCard,
                  {
                    backgroundColor: cardBg,
                    borderColor: cardBorder,
                    opacity: isConnecting && !isThisConnecting ? 0.5 : 1,
                  },
                ]}
                onPress={async () => {
                  if (isConnecting) return;
                  setIsConnecting(d.id);
                  const conn = await connectDevice(d);
                  if (!conn) {
                    setIsConnecting(null);
                    return;
                  }
                  await triggerPairing(conn, setupDevice);
                  const nonce = await receiveData(conn, setupDevice);
                  if (nonce == null) {
                    setIsConnecting(null);
                    return;
                  }
                  setConnected(conn);
                  setReceivedNonce(nonce);
                  setProcces(2);
                  setIsConnecting(null);
                }}
              >
                <View style={styles.deviceLeft}>
                  <View
                    style={[
                      styles.deviceIconBadge,
                      { backgroundColor: isDark ? "rgba(10,126,164,0.15)" : "#EFF8FC" },
                    ]}
                  >
                    <MaterialCommunityIcons name="bluetooth" size={16} color={colors.tint} />
                  </View>
                  <View style={styles.deviceInfo}>
                    <Text style={[styles.deviceName, { color: colors.text }]} numberOfLines={1}>
                      {d.name ?? d.localName ?? "이름 없음"}
                    </Text>
                    <Text
                      style={[styles.deviceId, { color: colors.tabIconDefault }]}
                      numberOfLines={1}
                    >
                      {d.id}
                    </Text>
                  </View>
                </View>
                <View style={styles.deviceRight}>
                  {isThisConnecting ? (
                    <ActivityIndicator size="small" color={colors.tint} />
                  ) : (
                    <MaterialCommunityIcons
                      name={signal.name as any}
                      size={22}
                      color={signal.color}
                    />
                  )}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // 초기 로딩
  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: colors.background }]}
      edges={["top"]}
    >
      <ActivityIndicator size="large" color={colors.tint} />
      <Text style={[styles.loadingText, { color: colors.text }]}>준비 중...</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  // 공통
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
  },

  // 폼 뷰 (process 2, 3)
  formContainer: {
    flex: 1,
    alignItems: "center",
  },
  pageHeaderRow: {
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 4,
  },
  stepBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 20,
    borderWidth: 1,
  },
  stepText: {
    fontSize: 13,
    fontWeight: "600",
  },
  formScroll: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    gap: 24,
  },
  formHero: {
    alignItems: "center",
    paddingTop: 32,
    gap: 12,
  },
  formTitle: {
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  formSub: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 20,
  },
  timerBadge: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 24,
    borderWidth: 1,
  },
  timerBadgeText: {
    fontSize: 15,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.5,
  },
  formFields: {
    gap: 16,
  },
  fieldWrap: {
    gap: 6,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "600",
    marginLeft: 2,
  },
  fieldInput: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
  },
  passwordWrap: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 16,
  },
  passwordInput: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 16,
  },
  eyeButton: {
    padding: 4,
  },
  submitButton: {
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  submitText: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "700",
    letterSpacing: 0.3,
  },

  // 스캔 뷰
  scanContainer: {
    flex: 1,
    alignItems: "center",
  },
  pageHeader: {
    width: "100%",
    paddingHorizontal: 24,
    paddingTop: 8,
    paddingBottom: 4,
  },
  pageTitle: {
    fontSize: 26,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  scanHero: {
    alignItems: "center",
    paddingTop: 40,
    paddingBottom: 32,
    gap: 20,
  },
  iconWrap: {
    width: 88,
    height: 88,
    alignItems: "center",
    justifyContent: "center",
  },
  iconCircle: {
    width: 88,
    height: 88,
    borderRadius: 44,
    borderWidth: 1.5,
    alignItems: "center",
    justifyContent: "center",
  },
  statusTextWrap: {
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 32,
  },
  statusTitle: {
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
  },
  statusSub: {
    fontSize: 13,
    textAlign: "center",
    lineHeight: 18,
  },
  timerWrap: {
    alignItems: "center",
  },
  timerValue: {
    fontSize: 22,
    fontWeight: "600",
    fontVariant: ["tabular-nums"],
    letterSpacing: 1,
  },
  rescanButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 24,
    borderWidth: 1.5,
  },
  rescanText: {
    fontSize: 15,
    fontWeight: "600",
  },
  listDivider: {
    width: "100%",
    borderTopWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: 10,
  },
  listHeader: {
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  deviceCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
  },
  deviceLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    flex: 1,
  },
  deviceIconBadge: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  deviceInfo: {
    flex: 1,
    gap: 3,
  },
  deviceName: {
    fontSize: 15,
    fontWeight: "600",
  },
  deviceId: {
    fontSize: 12,
  },
  deviceRight: {
    marginLeft: 12,
    width: 28,
    alignItems: "center",
  },
});
