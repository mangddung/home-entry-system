import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { UNFIGURED_DEVICES_KEY } from "@/lib/constants";
import { getTokenSecure } from "@/lib/token-storage";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export default function SetupScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const isDark = colorScheme === "dark";

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
});
