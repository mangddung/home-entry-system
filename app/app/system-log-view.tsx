import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { clearLogs, clearSystemLogs, readLogs, readSystemLogs } from "@/lib/system-log";
import { Button, Provider, Text, View } from "@ant-design/react-native";
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, TouchableOpacity } from "react-native";

type LogTab = "system" | "gps";

function getLogTypeColor(line: string): string {
  if (line.includes("[ERROR]")) return "#ff4d4f";
  if (line.includes("[WARN]")) return "#faad14";
  if (line.includes("[INFO]")) return "#52c41a";
  if (line.includes("[DEBUG]")) return "#8c8c8c";
  return "#d9d9d9";
}

export default function SystemLogView() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const textColor = Colors[colorScheme ?? "light"].text;

  const [tab, setTab] = useState<LogTab>("system");
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [clearing, setClearing] = useState(false);

  const loadLogs = useCallback((currentTab: LogTab = tab, showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const raw = currentTab === "system" ? readSystemLogs() : readLogs();
      setLines(raw.split("\n").filter((l) => l.trim().length > 0).reverse());
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [tab]);

  const handleClear = useCallback(() => {
    setClearing(true);
    try {
      if (tab === "system") clearSystemLogs();
      else clearLogs();
      setLines([]);
    } finally {
      setClearing(false);
    }
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
          <Text style={{ fontSize: 18, fontWeight: "700", color: textColor }}>
            {tab === "system" ? "시스템 로그" : "GPS 로그"}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button size="small" loading={loading} onPress={() => loadLogs()}>
              새로고침
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
          {(["system", "gps"] as LogTab[]).map((t) => (
            <TouchableOpacity
              key={t}
              onPress={() => handleTabChange(t)}
              style={{
                paddingVertical: 6,
                paddingHorizontal: 16,
                borderRadius: 16,
                backgroundColor: tab === t ? "#1677ff" : (isDark ? "#2a2d2e" : "#e5e7eb"),
              }}
            >
              <Text style={{ color: tab === t ? "#fff" : (isDark ? "#9BA1A6" : "#687076"), fontSize: 13 }}>
                {t === "system" ? "시스템" : "GPS"}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <FlatList
          data={lines}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item }) => {
            const sepIdx = item.indexOf("]: ");
            const meta = sepIdx !== -1 ? item.slice(0, sepIdx + 1) : item;
            const message = sepIdx !== -1 ? item.slice(sepIdx + 3) : null;
            const color = getLogTypeColor(item);
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
                      color,
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
                저장된 로그가 없습니다.
              </Text>
            </View>
          }
        />
      </View>
    </Provider>
  );
}
