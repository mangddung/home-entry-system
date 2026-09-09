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
    max_uses: number;
    use_count: number;
    not_before: string;
    expired_at: string;
  } | null;
  location: {
    latitude: number;
    longitude: number;
  } | null;
  last_ping_at: Date;
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
};

export type MemberInfo = {
  user_uuid: string;
  role: string;
  display_name: string;
  created_at: Date;
};
