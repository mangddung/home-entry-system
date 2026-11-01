import type { Schedule } from "./schedule";

// 제품 모델(서버 통신 경로). Wi-Fi = 상시 전원·HTTP 직접, Zigbee = 게이트웨이 경유
export type Transport = "wifi" | "zigbee";

export type IoTDevice = {
  device_uuid: string;
  device_nickname: string;
  role: string;
  ble_uuids: {
    ble_service_uuid: string;
    ble_write_uuid: string;
    ble_read_uuid: string;
    ble_manufacturer_uuid: string;
  };
  auth_token: {
    token_value: string;
    max_uses: number | null;
    use_count: number;
    not_before: string;
    expired_at: string;
    // 이전 버전 캐시에는 없을 수 있다
    schedule?: Schedule | null;
    schedule_tz?: string | null;
  } | null;
  location: {
    latitude: number;
    longitude: number;
  } | null;
  last_ping_at: Date;
  // 근접 해제 기기 임계값(dBm, 마스터 보정). null이면 첫 발견 즉시 연결. 이전 버전 캐시에는 없을 수 있다
  rssi_threshold?: number | null;
  // 이전 버전 캐시에는 없다 → Wi-Fi로 본다
  transport?: Transport;
};

export type DebugLog = {
  timestamp: string;
  event_name: string;
  log_type: string;
  message: string;
};

export type SetupUuids = {
  setup_service_uuid: string;
  setup_write_uuid: string;
  setup_read_uuid: string;
};

export type SysLog = {
  event_name: string;
  log_type: string;
  message: string;
};

export type DeviceStatus = {
  device_uuid: string;
  isInside: boolean;
  bleSuccess: boolean;
  enteredAt?: number; // 지오펜스 진입 시각 ms (수동 인증을 "늦음" 피드백으로 볼지 판단)
};

export type MemberInfo = {
  user_uuid: string;
  role: string;
  display_name: string;
  created_at: Date;
  // 게스트 행에만, 마스터가 조회할 때만 내려온다.
  has_token?: boolean;
};
