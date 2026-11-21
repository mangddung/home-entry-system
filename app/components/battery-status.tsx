// 배터리 잔량 표시. 홈 카드와 기기 상세가 같이 쓴다.
import { MaterialCommunityIcons } from "@expo/vector-icons";
import type { ComponentProps } from "react";
import { type StyleProp, StyleSheet, Text, type TextStyle, View } from "react-native";

const LOW_PERCENT = 20;
const LOW_COLOR = "#ef4444";

const iconName = (percent: number) => {
  if (percent <= 10) return "battery-alert";
  if (percent >= 95) return "battery";
  return `battery-${Math.round(percent / 10) * 10}` as ComponentProps<typeof MaterialCommunityIcons>["name"];
};

type Props = {
  percent: number;
  size: number;
  color: string;
  textStyle?: StyleProp<TextStyle>;
};

export function BatteryStatus({ percent, size, color, textStyle }: Props) {
  const tint = percent <= LOW_PERCENT ? LOW_COLOR : color;
  return (
    <View
      style={styles.row}
      accessible
      accessibilityLabel={`배터리 ${percent}퍼센트`}
    >
      <MaterialCommunityIcons name={iconName(percent)} size={size} color={tint} />
      <Text style={[textStyle, { color: tint }]}>{percent}%</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 3 },
});
