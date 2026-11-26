import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { showAlert } from "@/lib/alert";
import { fetchDeviceSetupToken, fetchSetupUuid, loadDevices } from "@/lib/api/devices";
import { SETUP_RESULT_TIMEOUT_MS, advertisedModel, connectDevice, receiveData, scanDevice, sendSetupCode, sendWifiSetup, sendZigbeeSetup, stopScan, triggerPairing } from "@/lib/ble";
import { commitBond, dropPendingBond, markPendingBond, resetBond } from "@/lib/bond";
import NetInfo from "@react-native-community/netinfo";
import { DEVICE_SETUP_KEY, MAX_DEVICES_PER_USER, UNFIGURED_DEVICES_KEY } from "@/lib/constants";
import { getTokenSecure, setTokenSecure } from "@/lib/token-storage";
import { IoTDevice, Transport } from "@/lib/types";
import { MODEL_LABEL, ModelIcon } from "@/components/model-icon";
import { scanWifi24GHz, WifiNetwork } from "@/lib/wifi";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
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
// 이 시간 동안 광고가 안 잡히면 목록에서 뺀다. 연결 대기 중이면 다른 휴대폰이 먼저 연결한 것으로 본다.
const STALE_MS = 3000;
// 스캔이 끝나 광고를 볼 수 없을 때의 연결 대기 상한
const CONNECT_TIMEOUT_MS = 10000;
const WIFI_LIST_PREVIEW_COUNT = 5;

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

// RSSI(dBm)를 4칸 신호 아이콘으로 변환. 잠금 여부까지 한 아이콘으로 표현한다.
function wifiSignalIcon(level: number, secured: boolean) {
  const bars = level >= -55 ? 4 : level >= -67 ? 3 : level >= -75 ? 2 : 1;
  return (secured ? `wifi-strength-${bars}-lock` : `wifi-strength-${bars}`) as any;
}

// 펌웨어가 보내는 WIFI_FAIL[:사유] 코드를 안내 문구로 변환
function wifiFailMessage(code: string): string {
  if (code === "WIFI_FAIL:NO_AP")
    return "해당 이름의 Wi-Fi를 찾지 못했습니다.\n\n기기는 2.4GHz Wi-Fi만 지원합니다. 5GHz 네트워크는 사용할 수 없으니 2.4GHz 네트워크를 선택해 주세요. Wi-Fi 이름에 오타가 없는지, 기기가 공유기 근처에 있는지도 확인해 주세요.";
  if (code === "WIFI_FAIL:AUTH")
    return "Wi-Fi 비밀번호가 올바르지 않습니다.\n\n비밀번호를 다시 확인해 주세요.";
  return "Wi-Fi에 연결하지 못했습니다.\n\nWi-Fi 이름과 비밀번호를 확인해 주세요. 기기는 2.4GHz Wi-Fi만 지원합니다.";
}

// Zigbee 모델 펌웨어가 보내는 ZB_FAIL:<사유> 코드를 안내 문구로 변환
function zigbeeFailMessage(code: string): string {
  if (code === "ZB_FAIL:JOIN")
    return "게이트웨이 네트워크를 찾지 못했습니다.\n\n게이트웨이가 켜져 있는지 확인하고 기기를 게이트웨이 가까이에 두고 다시 시도해 주세요.";
  return "서버 응답을 받지 못했습니다.\n\n게이트웨이의 인터넷 연결을 확인하고 잠시 후 다시 시도해 주세요.";
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
  const [transport, setTransport] = useState<Transport>("wifi");
  // 연결한 기기가 광고한 모델(펌웨어가 원천). 서버 기록과 교차 확인한다
  const advModelRef = useRef<Transport | null>(null);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [wifiList, setWifiList] = useState<WifiNetwork[]>([]);
  const [showAllWifi, setShowAllWifi] = useState(false);
  const [isScanningWifi, setIsScanningWifi] = useState(false);
  const [wifiScanError, setWifiScanError] = useState<string | null>(null);

  const [proccess, setProcces] = useState(0);
  const [isScanning, setIsScanning] = useState(false);
  const [isConnecting, setIsConnecting] = useState<string | null>(null);
  const lastSeenRef = useRef<Map<string, number>>(new Map());
  const isScanningRef = useRef(false);
  const [scanTimeLeft, setScanTimeLeft] = useState(SCAN_SECONDS);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    void (async () => {
      if ((await loadDevices()).length >= MAX_DEVICES_PER_USER) {
        showAlert("등록 제한", `기기는 최대 ${MAX_DEVICES_PER_USER}개까지 등록할 수 있습니다.`, [
          { text: "확인", onPress: () => router.back() },
        ]);
      }
    })();
  }, []);

  useEffect(() => {
    connectedRef.current = connected;
  }, [connected]);

  // 등록 완료 전에 화면을 벗어나면 방금 만든 본딩을 남기지 않는다
  useEffect(() => {
    return () => {
      void dropPendingBond();
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    disconnectIntentional.current = false;
    const subscription = connected.onDisconnected(() => {
      if (disconnectIntentional.current) return;
      showAlert("연결 끊김", "기기와의 연결이 끊어졌습니다.", [
        { text: "확인", onPress: () => router.replace("/") },
      ]);
    });
    return () => subscription.remove();
  }, [connected]);

  const startScan = useCallback(async (ioTDevice: IoTDevice) => {
    isScanningRef.current = true;
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
        return last !== undefined && now - last < STALE_MS;
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
    isScanningRef.current = false;
    setIsScanning(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      setProcces(0);
      void (async () => {
        await fetchSetupUuid();
        const raw = await getTokenSecure(DEVICE_SETUP_KEY);
        if (!raw) {
          showAlert("setup setupDevice fetch failed");
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

  // 2.4GHz Wi-Fi 목록 스캔 (Android 전용, iOS는 OS가 스캔 API를 제공하지 않음)
  const refreshWifiList = useCallback(async () => {
    setIsScanningWifi(true);
    const result = await scanWifi24GHz();
    setIsScanningWifi(false);
    setShowAllWifi(false);
    if (result.ok) {
      setWifiList(result.networks);
      setWifiScanError(null);
    } else {
      setWifiList([]);
      setWifiScanError(result.reason);
    }
    return result;
  }, []);

  // 목록을 못 띄우는 환경(iOS·권한 거부 등)에서만 현재 연결된 SSID를 자동 입력한다.
  // 목록이 있으면 사용자가 직접 고르므로 자동 입력하지 않는다.
  useEffect(() => {
    if (proccess !== 3 || transport === "zigbee") return;
    void (async () => {
      const result = await refreshWifiList();
      if (result.ok && result.networks.length > 0) return;
      const state = await NetInfo.fetch("wifi");
      if (state.type === "wifi" && state.details?.ssid) {
        setWifiSsid(state.details.ssid);
      }
    })();
  }, [proccess, transport, refreshWifiList]);

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

  // 기기가 보낸 최종 결과(REGISTERED / WIFI_FAIL:* / ZB_FAIL:* / TOKEN_FAIL) 처리. Wi-Fi·Zigbee 공용
  const finishRegistration = async (apiResponse: string | null) => {
    if (apiResponse == "REGISTERED") {
      await commitBond(deviceUuid);
      const device = [{ device_uuid: deviceUuid, type: "location" }];
      await setTokenSecure(UNFIGURED_DEVICES_KEY, JSON.stringify(device));
      router.push("/device/location-setup");
    } else if (apiResponse?.startsWith("WIFI_FAIL")) {
      showAlert("Wi-Fi 연결 실패", wifiFailMessage(apiResponse), [{ text: "확인" }]);
    } else if (apiResponse?.startsWith("ZB_FAIL")) {
      showAlert("게이트웨이 연결 실패", zigbeeFailMessage(apiResponse), [{ text: "확인" }]);
    } else {
      showAlert("설정 실패", "기기 등록에 실패했습니다. 잠시 후 다시 시도해 주세요.", [
        { text: "확인" },
      ]);
    }
  };

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
                // 펌웨어가 코드를 소문자로 바꿔 해시하므로 입력도 소문자로 맞춘다
                await sendSetupCode(connected, setupDevice!, receivedNonce, setupCode.trim().toLowerCase());
                // 기기는 "<device_uuid>:<리셋 증명>"을 보낸다(증명은 만들 수 있을 때만 붙는다)
                const [device_uuid, reset_proof] = ((await receiveData(connected!, setupDevice!)) ?? "").split(":");
                setDeviceUuid(device_uuid);
                const setup = await fetchDeviceSetupToken(device_uuid, reset_proof);
                setIsSubmitting(false);
                if (!("setup_token" in setup) || typeof setup.setup_token !== "string" || !setup.setup_token) {
                  showAlert("설정 실패", "설정 토큰을 받지 못했습니다. 다시 시도해 주세요.", [
                    { text: "확인" },
                  ]);
                  return;
                }
                // 기기가 광고한 모델(펌웨어)과 서버 기록(gen_config)이 다르면 잘못 설정된 기기다
                const adv = advModelRef.current;
                if (adv && adv !== setup.transport) {
                  showAlert(
                    "모델 정보 불일치",
                    `기기는 ${MODEL_LABEL[adv]} 모델로 동작하지만 서버에는 ${MODEL_LABEL[setup.transport]} 모델로 등록되어 있습니다. 기기를 다시 설정해 주세요.`,
                    [{ text: "확인" }],
                  );
                  return;
                }
                setSetupToken(setup.setup_token);
                setTransport(setup.transport);
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

  // Zigbee 모델: Wi-Fi 입력 없이 게이트웨이 네트워크 가입 + 서버 등록
  if (proccess == 3 && transport === "zigbee") {
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

        <ScrollView contentContainerStyle={styles.formScroll} showsVerticalScrollIndicator={false}>
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
              <ModelIcon transport="zigbee" size={38} color={colors.tint} />
            </View>
            <Text style={[styles.formTitle, { color: colors.text }]}>게이트웨이 연결</Text>
            <Text style={[styles.formSub, { color: colors.tabIconDefault }]}>
              {isSubmitting
                ? "기기가 게이트웨이에 가입하고 서버에 등록하는 중입니다 (최대 2분)"
                : "게이트웨이가 켜져 있는지 확인한 뒤 연결을 눌러 주세요"}
            </Text>
          </View>

          <TouchableOpacity
            style={[
              styles.submitButton,
              { backgroundColor: "#3B82F6", opacity: isSubmitting ? 0.7 : 1 },
            ]}
            disabled={isSubmitting}
            onPress={async () => {
              setIsSubmitting(true);
              // 다시 시도할 때 게이트웨이 가입 허용 시간(180초)이 지났을 수 있어 토큰을 다시 받아 가입을 다시 연다
              const setup = await fetchDeviceSetupToken(deviceUuid);
              const token = "setup_token" in setup && setup.setup_token ? setup.setup_token : setupToken;
              const sent = await sendZigbeeSetup(connected, setupDevice!, token);
              if (!sent) {
                setIsSubmitting(false);
                showAlert("설정 실패", "기기로 설정 정보를 보내지 못했습니다.", [{ text: "확인" }]);
                return;
              }
              const receiveResponse = await receiveData(connected!, setupDevice!);
              if (receiveResponse != "ACK") {
                console.log("not received");
              }
              const apiResponse = await receiveData(connected!, setupDevice!, SETUP_RESULT_TIMEOUT_MS);
              setIsSubmitting(false);
              await finishRegistration(apiResponse);
            }}
          >
            {isSubmitting ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.submitText}>연결</Text>
            )}
          </TouchableOpacity>
        </ScrollView>
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
                <View style={styles.fieldLabelRow}>
                  <Text style={[styles.fieldLabel, { color: colors.tabIconDefault }]}>
                    Wi-Fi 이름 (SSID)
                  </Text>
                  {Platform.OS === "android" && (
                    <TouchableOpacity
                      onPress={() => void refreshWifiList()}
                      disabled={isScanningWifi}
                      style={styles.wifiRescanButton}
                    >
                      {isScanningWifi ? (
                        <ActivityIndicator size="small" color={colors.tint} />
                      ) : (
                        <MaterialCommunityIcons name="refresh" size={18} color={colors.tint} />
                      )}
                    </TouchableOpacity>
                  )}
                </View>
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

                {/* 2.4GHz 목록 (Android). 기기가 5GHz를 지원하지 않아 2.4GHz만 노출한다. */}
                {wifiList.length > 0 && (
                  <View
                    style={[
                      styles.wifiList,
                      { backgroundColor: cardBg, borderColor: cardBorder },
                    ]}
                  >
                    {(showAllWifi ? wifiList : wifiList.slice(0, WIFI_LIST_PREVIEW_COUNT)).map((net) => {
                      const selected = net.ssid === wifiSsid;
                      return (
                        <TouchableOpacity
                          key={net.ssid}
                          style={[styles.wifiItem, { borderBottomColor: cardBorder }]}
                          onPress={() => setWifiSsid(net.ssid)}
                        >
                          <MaterialCommunityIcons
                            name={wifiSignalIcon(net.level, net.secured)}
                            size={20}
                            color={selected ? colors.tint : colors.tabIconDefault}
                          />
                          <Text
                            style={[
                              styles.wifiItemText,
                              { color: selected ? colors.tint : colors.text },
                            ]}
                            numberOfLines={1}
                          >
                            {net.ssid}
                          </Text>
                          {selected && (
                            <MaterialCommunityIcons name="check" size={18} color={colors.tint} />
                          )}
                        </TouchableOpacity>
                      );
                    })}
                    {wifiList.length > WIFI_LIST_PREVIEW_COUNT && (
                      <TouchableOpacity
                        style={[styles.wifiItem, { borderBottomColor: cardBorder }]}
                        onPress={() => setShowAllWifi((v) => !v)}
                      >
                        <MaterialCommunityIcons
                          name={showAllWifi ? "chevron-up" : "chevron-down"}
                          size={20}
                          color={colors.tabIconDefault}
                        />
                        <Text
                          style={[styles.wifiItemText, { color: colors.tabIconDefault }]}
                          numberOfLines={1}
                        >
                          {showAllWifi
                            ? "접기"
                            : `더 보기 (${wifiList.length - WIFI_LIST_PREVIEW_COUNT}개)`}
                        </Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {wifiScanError && (
                  <Text style={[styles.wifiHint, { color: colors.tabIconDefault }]}>
                    {wifiScanError === "unsupported"
                      ? "기기는 2.4GHz Wi-Fi만 지원합니다. 5GHz 네트워크는 사용할 수 없습니다."
                      : wifiScanError === "permission"
                        ? "Wi-Fi 목록을 보려면 위치 권한이 필요합니다. 이름을 직접 입력해도 됩니다."
                        : wifiScanError === "location-off"
                          ? "Wi-Fi 목록을 보려면 위치 서비스를 켜 주세요. 이름을 직접 입력해도 됩니다."
                          : "Wi-Fi 목록을 불러오지 못했습니다. 이름을 직접 입력해 주세요."}
                  </Text>
                )}
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
                const sent = await sendWifiSetup(
                  connected,
                  setupDevice!,
                  wifiSsid,
                  wifiPassword,
                  setupToken,
                );
                if (!sent) {
                  setIsSubmitting(false);
                  showAlert("설정 실패", "기기로 설정 정보를 보내지 못했습니다.", [
                    { text: "확인" },
                  ]);
                  return;
                }
                const receiveResponse = await receiveData(connected!, setupDevice!);
                if (receiveResponse != "ACK") {
                  console.log("not received");
                }
                const apiResponse = await receiveData(connected!, setupDevice!, SETUP_RESULT_TIMEOUT_MS);
                setIsSubmitting(false);
                await finishRegistration(apiResponse);
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
                  await resetBond(d.id);
                  const startedAt = Date.now();
                  // 기기는 연결 1개만 받고 연결되면 광고를 멈춘다. 대기 중에 광고가 사라지면 다른 휴대폰이 잡은 것.
                  const conn = await connectDevice(d, 0, () =>
                    isScanningRef.current
                      ? Date.now() - (lastSeenRef.current.get(d.id) ?? 0) >= STALE_MS
                      : Date.now() - startedAt >= CONNECT_TIMEOUT_MS,
                  );
                  if (!conn) {
                    setIsConnecting(null);
                    showAlert(
                      "연결 실패",
                      "기기에 연결하지 못했습니다. 다른 휴대폰이 이미 연결 중일 수 있습니다. 잠시 후 다시 시도해 주세요.",
                    );
                    return;
                  }
                  advModelRef.current = advertisedModel(d);
                  await markPendingBond(d.id);
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
                    <View style={styles.deviceNameRow}>
                      <Text style={[styles.deviceName, { color: colors.text }]} numberOfLines={1}>
                        {d.name ?? d.localName ?? "이름 없음"}
                      </Text>
                      {advertisedModel(d) && (
                        <ModelIcon transport={advertisedModel(d)} size={14} color={colors.tabIconDefault} />
                      )}
                    </View>
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
  fieldLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  wifiRescanButton: {
    padding: 4,
  },
  wifiList: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: "hidden",
  },
  wifiItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  wifiItemText: {
    flex: 1,
    fontSize: 15,
  },
  wifiHint: {
    fontSize: 12,
    lineHeight: 17,
    marginLeft: 2,
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
  deviceNameRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  deviceName: {
    flexShrink: 1,
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
