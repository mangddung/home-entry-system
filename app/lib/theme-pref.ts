// 앱 테마 선택(시스템/라이트/다크). Appearance.setColorScheme가 RN useColorScheme 전역을 덮어쓰므로
// 화면 코드는 기존 useColorScheme 그대로 쓴다.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Appearance } from "react-native";

export type ThemePref = "system" | "light" | "dark";

const THEME_PREF_KEY = "theme-pref";

export async function getThemePref(): Promise<ThemePref> {
  const v = await AsyncStorage.getItem(THEME_PREF_KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyThemePref(pref: ThemePref) {
  Appearance.setColorScheme(pref === "system" ? null : pref);
}

export async function setThemePref(pref: ThemePref) {
  applyThemePref(pref);
  await AsyncStorage.setItem(THEME_PREF_KEY, pref);
}
