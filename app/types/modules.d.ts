declare module "react-native-battery-optimization-check" {
  export function BatteryOptEnabled(): Promise<boolean>;
  export function RequestDisableOptimization(): void;
  export function OpenOptimizationSettings(): void;
}
