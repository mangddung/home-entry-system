import axios from "axios";
import { router } from "expo-router";
import {
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
import { stopBackgroundTracking } from "../background-tracking";
import { triggerSessionAlert } from "../session-alert";
import { getTokenSecure, setTokenSecure } from "../token-storage";
import { refreshToken } from "./auth";
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
  await stopBackgroundTracking();
}

let isHandling401 = false;

// 동시에 401을 받은 요청들이 refresh를 각각 호출하지 않도록 한 번만 수행하고 결과를 공유한다.
let refreshPromise: Promise<boolean> | null = null;

async function refreshOnce(): Promise<boolean> {
  if (!refreshPromise) {
    refreshPromise = refreshToken()
      .then((result) => result.type === "success")
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export function setupAxiosInterceptors() {
  axios.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config as (typeof error.config & { _retried?: boolean }) | undefined;
      const isRefreshCall = typeof config?.url === "string" && config.url.includes("/auth/refresh");

      if (error.response?.status === 401 && config && !config._retried && !isRefreshCall) {
        config._retried = true;
        if (await refreshOnce()) {
          const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
          if (access_token) {
            config.headers = { ...config.headers, Authorization: `Bearer ${access_token}` };
          }
          return axios(config);
        }
      }

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
