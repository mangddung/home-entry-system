import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { AUTH_LOG_CATEGORIES, type AuthLogCategory, clearAuthLogs, readAuthLogs } from "@/lib/auth-log";
import { clearLogs, clearSystemLogs, readLogs, readSystemLogs } from "@/lib/system-log";
import { Button, Provider, Text, View } from "@ant-design/react-native";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Share, TouchableOpacity } from "react-native";

type LogTab = "system" | "gps" | "auth";
type AuthFilter = AuthLogCategory | "ALL";

const TAB_LABELS: Record<LogTab, string> = { system: "시스템", gps: "GPS", auth: "자동 인증" };
const TAB_TITLES: Record<LogTab, string> = { system: "시스템 로그", gps: "GPS 로그", auth: "자동 인증 로그" };

// 자동 인증 로그 분류별 색 (lib/auth-log.ts)
const AUTH_COLORS: Record<AuthLogCategory, string> = {
  GEOFENCE: "#1677ff",
  ACTIVITY: "#722ed1",
  BLE: "#13a8a8",
  AUTH: "#52c41a",
  SERVICE: "#8c8c8c",
  PUSH: "#fa8c16",
  ERROR: "#ff4d4f",
};
const AUTH_FILTER_LABELS: Record<AuthFilter, string> = {
  ALL: "전체",
  GEOFENCE: "지오펜스",
  ACTIVITY: "활동",
  BLE: "BLE",
  AUTH: "인증",
  SERVICE: "서비스",
  PUSH: "서버 결과",
  ERROR: "오류",
};

function getLogTypeColor(line: string): string {
  if (line.includes("[ERROR]")) return "#ff4d4f";
  if (line.includes("[WARN]")) return "#faad14";
  if (line.includes("[INFO]")) return "#52c41a";
  if (line.includes("[DEBUG]")) return "#8c8c8c";
  return "#d9d9d9";
}

// 시스템/GPS: "[시각][종류][이벤트]: 메시지", 자동 인증: "[시각][분류] 메시지"
function splitLine(line: string, tab: LogTab): { meta: string; message: string | null; category?: AuthLogCategory } {
  if (tab === "auth") {
    const m = line.match(/^(\[[^\]]*\]\[([A-Z]+)\]) ?(.*)$/);
    if (!m) return { meta: line, message: null };
    return { meta: m[1], message: m[3], category: m[2] as AuthLogCategory };
  }
  const sepIdx = line.indexOf("]: ");
  return sepIdx !== -1 ? { meta: line.slice(0, sepIdx + 1), message: line.slice(sepIdx + 3) } : { meta: line, message: null };
}

export default function SystemLogView() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const textColor = Colors[colorScheme ?? "light"].text;
  const params = useLocalSearchParams<{ tab?: string }>();

  const [tab, setTab] = useState<LogTab>(params.tab === "auth" ? "auth" : "system");
  const [authFilter, setAuthFilter] = useState<AuthFilter>("ALL");
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);

  const readTab = (t: LogTab) => (t === "system" ? readSystemLogs() : t === "gps" ? readLogs() : readAuthLogs());

  const loadLogs = useCallback((currentTab: LogTab = tab, showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      setLines(readTab(currentTab).split("\n").filter((l) => l.trim().length > 0).reverse());
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [tab]);

  const handleClear = useCallback(() => {
    setClearing(true);
    try {
      if (tab === "system") clearSystemLogs();
      else if (tab === "gps") clearLogs();
      else clearAuthLogs();
      setLines([]);
    } finally {
      setClearing(false);
    }
  }, [tab]);

  // 디버깅 때 로그를 통째로 보낼 수 있게 시간순 원문을 공유한다
  const handleShare = useCallback(() => {
    void Share.share({ message: readTab(tab) || "(로그 없음)" });
  }, [tab]);

  const handleTabChange = (next: LogTab) => {
    setTab(next);
    loadLogs(next);
  };

  useFocusEffect(
    useCallback(() => {
      loadLogs(tab);
      const interval = setInterval(() => loadLogs(tab, false), 1000);
      return () => clearInterval(interval);
    }, [loadLogs]),
  );

  const visible =
    tab === "auth" && authFilter !== "ALL" ? lines.filter((l) => l.includes(`][${authFilter}]`)) : lines;

  const chip = (active: boolean, activeColor = "#1677ff") => ({
    paddingVertical: 6,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: active ? activeColor : isDark ? "#2a2d2e" : "#e5e7eb",
  });
  const chipText = (active: boolean) => ({ color: active ? "#fff" : isDark ? "#9BA1A6" : "#687076", fontSize: 13 });

  return (
    <Provider>
      <View style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: "row",
            justifyContent: "space-between",
            alignItems: "center",
            padding: 16,
          }}
        >
          <Text style={{ fontSize: 18, fontWeight: "700", color: textColor }}>{TAB_TITLES[tab]}</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button size="small" loading={loading} onPress={() => loadLogs()}>
              새로고침
            </Button>
            <Button size="small" onPress={handleShare}>
              공유
            </Button>
            <Button
              size="small"
              type="warning"
              loading={clearing}
              onPress={handleClear}
            >
              초기화
            </Button>
          </View>
        </View>

        <View style={{ flexDirection: "row", paddingHorizontal: 16, marginBottom: 8, gap: 8 }}>
          {(["system", "gps", "auth"] as LogTab[]).map((t) => (
            <TouchableOpacity key={t} onPress={() => handleTabChange(t)} style={chip(tab === t)}>
              <Text style={chipText(tab === t)}>{TAB_LABELS[t]}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {tab === "auth" && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 16, marginBottom: 8, gap: 6 }}>
            {(["ALL", ...AUTH_LOG_CATEGORIES] as AuthFilter[]).map((c) => (
              <TouchableOpacity
                key={c}
                onPress={() => setAuthFilter(c)}
                style={chip(authFilter === c, c === "ALL" ? "#1677ff" : AUTH_COLORS[c])}
              >
                <Text style={chipText(authFilter === c)}>{AUTH_FILTER_LABELS[c]}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <FlatList
          data={visible}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => {
            const { meta, message, category } = splitLine(item, tab);
            const color = tab === "auth" ? (category && AUTH_COLORS[category]) ?? "#8c8c8c" : getLogTypeColor(item);
            return (
              <View
                style={{
                  paddingHorizontal: 16,
                  paddingVertical: 4,
                  borderBottomWidth: 1,
                  borderBottomColor: isDark ? "#2a2d2e" : "#f0f0f0",
                }}
              >
                <Text style={{ fontSize: 11, fontFamily: "monospace", color }}>
                  {meta}
                </Text>
                {message && (
                  <Text
                    style={{
                      fontSize: 11,
                      fontFamily: "monospace",
                      color: tab === "auth" ? textColor : color,
                      paddingLeft: 8,
                      opacity: 0.9,
                    }}
                  >
                    {message}
                  </Text>
                )}
              </View>
            );
          }}
          contentContainerStyle={{ paddingBottom: 24 }}
          ListEmptyComponent={
            <View style={{ padding: 16 }}>
              <Text style={{ color: textColor }}>
                {tab === "auth"
                  ? "자동 인증 기록이 없습니다. 지오펜스 진입·걸음 판정·BLE 시도가 생기면 여기에 쌓입니다."
                  : "저장된 로그가 없습니다."}
              </Text>
            </View>
          }
        />
      </View>
    </Provider>
  );
}
