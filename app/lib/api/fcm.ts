import { getApp } from "@react-native-firebase/app";
import { getMessaging, getToken, deleteToken, requestPermission, AuthorizationStatus } from "@react-native-firebase/messaging";
import axios from "axios";
import { BACKEND_URL, USER_ACCESS_TOKEN_KEY } from "../constants";
import { getTokenSecure } from "../token-storage";
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
    return { type: "forbidden", message: "알림 권한이 없습니다." };
  }

  const fcm_token = await getToken(m);

  try {
    const response = await axios.post(
      `${BACKEND_URL}/client/fcm-token`,
      { fcm_token: fcm_token },
      { headers: { Authorization: `Bearer ${access_token}` }, timeout: 5000 },
    );
    return { type: "success", data: response.data.data };
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      return { type: "no_response", message: "서버에 연결할 수 없습니다." };
    }
    return { type: "forbidden", message: getApiErrorMessage(error) };
  }
};

export const revokeFcmToken = async () => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
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
