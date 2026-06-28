import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { UNFIGURED_DEVICES_KEY } from "@/lib/constants";
import { getTokenSecure } from "@/lib/token-storage";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

const BTN_BOTTOM_DEFAULT = 24;

export default function SetupScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const isDark = colorScheme === "dark";
  const btnBottom = useRef(new Animated.Value(BTN_BOTTOM_DEFAULT)).current;

  const [targetDevice, setTargetDevice] = useState<{ device_uuid: string } | null>(null);

  useEffect(() => {
    void (async () => {
      const target_device = await getTokenSecure(UNFIGURED_DEVICES_KEY);
      if (!target_device) {
        router.push("/home");
        return;
      }
      const parsed_target_device = JSON.parse(target_device);
      const setting_devices = parsed_target_device.filter((d: any) => d.type == "setting");
      if (setting_devices.length == 0) {
        router.push("/home");
        return;
      }
      setTargetDevice(setting_devices[0]);
    })();
  }, []);

  return (
    <SafeAreaView style={styles.container} edges={["top"]}>
      <View style={[styles.titleBar, { backgroundColor: colors.background, borderBottomColor: isDark ? "#2a2d2e" : "#eee" }]}>
        <Text style={[styles.titleText, { color: colors.text }]}>{targetDevice?.device_uuid ?? "위치 설정"}</Text>
      </View>
      <Animated.View style={[styles.locateBtn, { bottom: btnBottom, backgroundColor: isDark ? "#1e2022" : "#fff" }]}>
        <TouchableOpacity style={styles.locateBtnInner} onPress={handleLocate}>
          <Ionicons name="locate" size={22} color="#4285F4" />
        </TouchableOpacity>
      </Animated.View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  titleBar: {
    height: 52,
    justifyContent: "center",
    paddingHorizontal: 20,
    borderBottomWidth: 1,
  },
  titleText: {
    fontSize: 17,
    fontWeight: "700",
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
});
