// 서보 범위 수직 슬라이더. 막대 양 끝의 두 손잡이로 동작·대기 각도를 조절하고 옆에 각도를 보여준다.
// 손잡이는 서로 넘어가지 못한다. 드래그 실수로 동작 방향이 뒤집히면 잠금 기구에 무리가 가기 때문이다.
import { useRef, useState } from "react";
import { PanResponder, StyleSheet, Text, View } from "react-native";

const DEG_MAX = 180;
const MIN_SWING_DEG = 10; // 서버 SERVO_MIN_SWING_DEG와 같은 값
const TRACK_PAD = 26; // 막대 끝에서 손잡이 중심까지 최소 거리
const FILL_INSET = 6;
const FILL_CAP = TRACK_PAD - FILL_INSET; // 채움이 손잡이 바깥으로 나가는 길이
const LABEL_HEIGHT = 52;
const ACCENT = "#16a34a";

// low = 동작 각도, high = 대기 각도 (펌웨어 servo_get_low/high). 숫자 크기와는 무관하다.
export type ServoRange = { low: number; high: number };
type Handle = keyof ServoRange;

const LABELS: Record<Handle, string> = { low: "동작 각도", high: "대기 각도" };

// 움직이는 손잡이가 다른 손잡이를 넘지 않게 자른다
const clampHandle = (range: ServoRange, handle: Handle, deg: number) => {
  const other = range[handle === "low" ? "high" : "low"];
  const [min, max] = range[handle] > other ? [other + MIN_SWING_DEG, DEG_MAX] : [0, other - MIN_SWING_DEG];
  return Math.min(max, Math.max(min, deg));
};

type Props = {
  range: ServoRange;
  disabled: boolean;
  onChange: (range: ServoRange) => void;
  // 손잡이를 잡거나 움직일 때 그 각도로 불린다. 서보를 바로 따라오게 하는 데 쓴다.
  onDrag: (deg: number) => void;
  colors: { text: string; icon: string };
  trackColor: string;
  tickColor: string;
};

export function ServoRangeSlider({ range, disabled, onChange, onDrag, colors, trackColor, tickColor }: Props) {
  const [trackHeight, setTrackHeight] = useState(0);
  const [active, setActive] = useState<Handle | null>(null);

  const usable = Math.max(1, trackHeight - TRACK_PAD * 2);
  const yOf = (deg: number) => TRACK_PAD + (1 - deg / DEG_MAX) * usable;

  // PanResponder는 처음 한 번만 만들어지므로 최신 값은 ref로 읽는다
  const latest = useRef({ range, disabled, onChange, onDrag, usable, yOf });
  latest.current = { range, disabled, onChange, onDrag, usable, yOf };
  const drag = useRef<{ handle: Handle; startDeg: number } | null>(null);

  const endDrag = () => {
    drag.current = null;
    setActive(null);
  };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !latest.current.disabled,
      onMoveShouldSetPanResponder: () => !latest.current.disabled,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        const { range: r, yOf: y } = latest.current;
        const touchY = e.nativeEvent.locationY;
        const handle: Handle = Math.abs(touchY - y(r.low)) <= Math.abs(touchY - y(r.high)) ? "low" : "high";
        drag.current = { handle, startDeg: r[handle] };
        setActive(handle);
        latest.current.onDrag(r[handle]);
      },
      onPanResponderMove: (_, gesture) => {
        if (!drag.current) return;
        const { handle, startDeg } = drag.current;
        const { range: r, usable: u, onChange: change, onDrag: dragTo } = latest.current;
        const deg = clampHandle(r, handle, Math.round(startDeg - (gesture.dy / u) * DEG_MAX));
        if (deg !== r[handle]) {
          change({ ...r, [handle]: deg });
          dragTo(deg);
        }
      },
      onPanResponderRelease: endDrag,
      onPanResponderTerminate: endDrag,
    }),
  ).current;

  const upper = Math.max(range.low, range.high);
  const lower = Math.min(range.low, range.high);

  const angleLabel = (handle: Handle, side: "left" | "right") => {
    const value = range[handle];
    const isActive = active === handle;
    return (
      <View
        style={[styles.label, { top: yOf(value) - LABEL_HEIGHT / 2 }, side === "left" ? styles.labelLeft : styles.labelRight]}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={LABELS[handle]}
        accessibilityState={{ disabled }}
        accessibilityValue={{ min: 0, max: DEG_MAX, now: value, text: `${value}도` }}
        accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
        onAccessibilityAction={(e) => {
          if (disabled) return;
          const step = e.nativeEvent.actionName === "increment" ? 1 : -1;
          const deg = clampHandle(range, handle, value + step);
          onChange({ ...range, [handle]: deg });
          onDrag(deg);
        }}
      >
        <View style={[styles.labelText, side === "left" ? styles.alignEnd : styles.alignStart]}>
          <Text style={[styles.labelCaption, { color: colors.icon }]} numberOfLines={1}>
            {LABELS[handle]}
          </Text>
          <Text style={[styles.labelValue, { color: isActive ? ACCENT : colors.text }]}>{value}°</Text>
        </View>
        <View style={[styles.tick, { backgroundColor: isActive ? ACCENT : tickColor }]} />
      </View>
    );
  };

  return (
    <View style={[styles.row, disabled && { opacity: 0.6 }]}>
      <View style={styles.side}>{trackHeight > 0 && angleLabel("high", "left")}</View>

      <View
        style={[styles.track, { backgroundColor: trackColor }]}
        onLayout={(e) => setTrackHeight(e.nativeEvent.layout.height)}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        {...pan.panHandlers}
      >
        {trackHeight > 0 && (
          <View style={StyleSheet.absoluteFill} pointerEvents="none">
            <Text style={[styles.endMark, { top: 8, color: colors.icon }]}>{DEG_MAX}°</Text>
            <Text style={[styles.endMark, { bottom: 8, color: colors.icon }]}>0°</Text>
            <View
              style={[
                styles.fill,
                { top: yOf(upper) - FILL_CAP, height: yOf(lower) - yOf(upper) + FILL_CAP * 2 },
              ]}
            />
            {(["low", "high"] as const).map((handle) => (
              <View
                key={handle}
                style={[styles.grip, active === handle && styles.gripActive, { top: yOf(range[handle]) - 2.5 }]}
              />
            ))}
          </View>
        )}
      </View>

      <View style={styles.side}>{trackHeight > 0 && angleLabel("low", "right")}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flex: 1, minHeight: 240, maxHeight: 480, flexDirection: "row" },
  side: { flex: 1 },
  track: { width: 104, borderRadius: 32, overflow: "hidden" },
  endMark: {
    position: "absolute",
    alignSelf: "center",
    fontSize: 11,
    fontVariant: ["tabular-nums"],
  },
  fill: {
    position: "absolute",
    left: FILL_INSET,
    right: FILL_INSET,
    borderRadius: 26,
    backgroundColor: ACCENT,
  },
  grip: {
    position: "absolute",
    alignSelf: "center",
    width: 40,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: "#fff",
  },
  gripActive: { width: 56 },
  label: {
    position: "absolute",
    height: LABEL_HEIGHT,
    alignItems: "center",
    gap: 8,
  },
  labelLeft: { left: 0, right: 0, flexDirection: "row", justifyContent: "flex-end" },
  labelRight: { left: 0, right: 0, flexDirection: "row-reverse", justifyContent: "flex-end" },
  labelText: { flexShrink: 1, gap: 1 },
  alignStart: { alignItems: "flex-start" },
  alignEnd: { alignItems: "flex-end" },
  labelCaption: { fontSize: 12 },
  labelValue: { fontSize: 26, lineHeight: 30, fontWeight: "700", fontVariant: ["tabular-nums"] },
  tick: { width: 12, height: StyleSheet.hairlineWidth * 2 },
});
