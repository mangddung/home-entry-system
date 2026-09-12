import { getApp } from "@react-native-firebase/app";
import { getMessaging, getToken, deleteToken, requestPermission, AuthorizationStatus } from "@react-native-firebase/messaging";
import axios from "axios";
import { BACKEND_URL, USER_ACCESS_TOKEN_KEY } from "../constants";
import { getTokenSecure } from "../token-storage";
import { appendSystemLog } from "../system-log";
import { getApiErrorMessage } from "./errors";

// POST /client/fcm-token   body: { fcm_token }
export const fetchFcmToken = async () => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  const m = getMessaging(getApp());
  const status = await requestPermission(m);
  if (status !== AuthorizationStatus.AUTHORIZED && status !== AuthorizationStatus.PROVISIONAL) {
    appendSystemLog({ event_name: "Login", log_type: "WARNING", message: "fcm 토큰 등록 실패: 알림 권한 없음" });
    return { type: "forbidden", message: "알림 권한이 없습니다." };
  }

  const fcm_token = await getToken(m);

  try {
    const response = await axios.post(
      `${BACKEND_URL}/client/fcm-token`,
      { fcm_token: fcm_token },
      { headers: { Authorization: `Bearer ${access_token}` }, timeout: 5000 },
    );
    appendSystemLog({ event_name: "Login", log_type: "INFO", message: "fcm 토큰 등록 성공" });
    return { type: "success", data: response.data.data };
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      appendSystemLog({ event_name: "Login", log_type: "ERROR", message: "fcm 토큰 등록 실패: 서버 연결 불가" });
      return { type: "no_response", message: "서버에 연결할 수 없습니다." };
    }
    appendSystemLog({ event_name: "Login", log_type: "ERROR", message: `fcm 토큰 등록 실패: ${getApiErrorMessage(error)}` });
    return { type: "forbidden", message: getApiErrorMessage(error) };
  }
};

// 로그아웃에서는 토큰을 미리 읽어 넘긴다(스토리지를 지우는 것과 동시에 돌기 때문).
export const revokeFcmToken = async (token?: string) => {
  const access_token = token ?? (await getTokenSecure(USER_ACCESS_TOKEN_KEY));
  try {
    const m = getMessaging(getApp());
    await deleteToken(m);
  } catch {
    // ignore firebase errors
  }
  if (!access_token) return;
  try {
    await axios.delete(`${BACKEND_URL}/client/fcm-token`, {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 5000,
    });
  } catch {
    // ignore server errors
  }
};
