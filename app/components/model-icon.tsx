import { Transport } from "@/lib/types";
import { MaterialCommunityIcons } from "@expo/vector-icons";

export const MODEL_LABEL: Record<Transport, string> = { wifi: "Wi-Fi", zigbee: "Zigbee" };

// 제품 모델 아이콘(Wi-Fi / Zigbee). 모델 정보가 없는 이전 캐시·기기는 Wi-Fi로 본다.
export function ModelIcon({ transport, size = 14, color }: { transport?: Transport | null; size?: number; color: string }) {
  const model = transport ?? "wifi";
  return (
    <MaterialCommunityIcons
      name={model === "zigbee" ? "zigbee" : "wifi"}
      size={size}
      color={color}
      accessibilityLabel={`${MODEL_LABEL[model]} 모델`}
    />
  );
}
