import { PermissionsAndroid, Platform } from "react-native";
import WifiManager from "react-native-wifi-reborn";

// ESP32-C6는 2.4GHz만 지원한다. 5GHz(4900~5900MHz) / 6GHz AP는 목록에서 제외한다.
const isBand24 = (frequencyMHz: number) => frequencyMHz < 3000;

export type WifiNetwork = {
  ssid: string;
  level: number;   // dBm, 0에 가까울수록 강함
  secured: boolean;
};

export type WifiScanResult =
  | { ok: true; networks: WifiNetwork[] }
  | { ok: false; reason: "unsupported" | "permission" | "location-off" | "failed" };

// 2.4GHz 네트워크 목록을 스캔한다. iOS는 OS가 Wi-Fi 스캔 API를 제공하지 않아 항상 unsupported.
export async function scanWifi24GHz(): Promise<WifiScanResult> {
  if (Platform.OS !== "android") return { ok: false, reason: "unsupported" };

  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  );
  if (granted !== PermissionsAndroid.RESULTS.GRANTED) return { ok: false, reason: "permission" };

  try {
    const entries = await WifiManager.loadWifiList();
    const byBestSignal = new Map<string, WifiNetwork>();

    for (const e of entries) {
      if (!e.SSID || !isBand24(e.frequency)) continue;
      // 같은 SSID가 여러 AP/대역으로 잡히면 신호 강한 쪽만 남긴다
      const prev = byBestSignal.get(e.SSID);
      if (prev && prev.level >= e.level) continue;
      byBestSignal.set(e.SSID, {
        ssid: e.SSID,
        level: e.level,
        secured: /WEP|WPA|WPA2|WPA3|PSK|EAP/i.test(e.capabilities ?? ""),
      });
    }

    const networks = [...byBestSignal.values()].sort((a, b) => b.level - a.level);
    return { ok: true, networks };
  } catch (err: any) {
    const code = String(err?.code ?? err?.message ?? "");
    if (code.includes("locationPermissionMissing")) return { ok: false, reason: "permission" };
    if (code.includes("locationServicesOff")) return { ok: false, reason: "location-off" };
    return { ok: false, reason: "failed" };
  }
}
