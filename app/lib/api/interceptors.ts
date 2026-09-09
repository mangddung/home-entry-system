import axios from "axios";
import * as Location from "expo-location";
import { router } from "expo-router";
import * as TaskManager from "expo-task-manager";
import {
  BG_GEOFENCE_TASK,
  BG_LOCATION_TASK,
  CURRENT_LOCATION_KEY,
  DEVICE_STATUS_KEY,
  IS_ONLINE_KEY,
  SELECTED_DEVICE_KEY,
  UNFIGURED_DEVICES_KEY,
  USER_ACCESS_TOKEN_KEY,
  USER_NAME_KEY,
  USER_REFRESH_TOKEN_KEY,
  USER_SECRET_KEY,
  USER_UUID_KEY,
} from "../constants";
import { cancelTrackingNotification } from "../background-tracking";
import { triggerSessionAlert } from "../session-alert";
import { setTokenSecure } from "../token-storage";
import { clearDeviceStorage } from "./devices";

async function clearSession() {
  await Promise.all([
    setTokenSecure(USER_SECRET_KEY, ""),
    setTokenSecure(USER_NAME_KEY, ""),
    setTokenSecure(USER_UUID_KEY, ""),
    setTokenSecure(USER_ACCESS_TOKEN_KEY, ""),
    setTokenSecure(USER_REFRESH_TOKEN_KEY, ""),
    clearDeviceStorage(),
    setTokenSecure(UNFIGURED_DEVICES_KEY, ""),
    setTokenSecure(SELECTED_DEVICE_KEY, ""),
    setTokenSecure(IS_ONLINE_KEY, ""),
    setTokenSecure(CURRENT_LOCATION_KEY, ""),
    setTokenSecure(DEVICE_STATUS_KEY, ""),
  ]);
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BG_LOCATION_TASK);
    if (isRegistered) await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
    const isGeofenceRegistered = await TaskManager.isTaskRegisteredAsync(BG_GEOFENCE_TASK);
    if (isGeofenceRegistered) await Location.stopGeofencingAsync(BG_GEOFENCE_TASK);
    await cancelTrackingNotification();
  } catch {}
}

let isHandling401 = false;

export function setupAxiosInterceptors() {
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response?.status === 401 && !isHandling401) {
        isHandling401 = true;
        triggerSessionAlert("세션 만료", "로그인이 필요합니다. 다시 로그인해주세요.", async () => {
          await clearSession();
          router.replace("/login-oauth");
          isHandling401 = false;
        });
      }
      return Promise.reject(error);
    },
  );
}
