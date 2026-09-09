export const USER_SECRET_KEY = "ble-encryption-key";
export const USER_ACCESS_TOKEN_KEY = "user-access-token-key";
export const USER_REFRESH_TOKEN_KEY = "user-refresh-token-key";
export const USER_NAME_KEY = "user-name";
export const USER_UUID_KEY = "user-uuid";
export const USER_DEVICES_KEY = "user-devices";
export const DEVICE_KEY_PREFIX = "device-";
export const DEVICE_SETUP_KEY = "device-setup";

export const DEBUG_LOG = "debug-log";
export const IS_ONLINE_KEY = "is-online";
export const BACKEND_URL = "https://your-server.example.com";

export const BG_LOCATION_TASK = "BG-Tracking";
export const BG_GEOFENCE_TASK = "BG-Geofence";
export const LOCATION_UPDATE_EVENT = "locationUpdate";
export const GEOFENCE_UPDATED_AT_KEY = "geofence_updated_at";
export const CURRENT_LOCATION_KEY = "current_location";
export const DEVICE_STATUS_KEY = "device_status";

export const UNFIGURED_DEVICES_KEY = "unfigured_devices";
export const SELECTED_DEVICE_KEY = "selected_device";

export const FCM_NOTIFICATIONS_KEY = "fcm_notifications";
export const FCM_NOTIFICATIONS_LAST_READ_AT_KEY = "fcm_notifications_last_read_at";

// 서버(server/app/utils/device_utils.py의 MAX_DEVICES_PER_USER)와 값 맞출 것
export const MAX_DEVICES_PER_USER = 20;

// Android Geofencing API는 반경 100m 미만을 신뢰성 있게 판정하지 못해 진입 자체가 누락된다.
// 그래서 반경은 사용자가 고르지 않고 이 값으로 고정하고, 실제 근접 판정은 BLE 스캔이 담당한다.
export const GEOFENCE_RADIUS_M = 150;
