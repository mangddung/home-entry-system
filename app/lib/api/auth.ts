import axios from "axios";
import {
  BACKEND_URL,
  USER_ACCESS_TOKEN_KEY,
  USER_REFRESH_TOKEN_KEY,
  USER_SECRET_KEY,
} from "../constants";
import { getTokenSecure, setTokenSecure } from "../token-storage";
import { appendSystemLog } from "../system-log";
import { getApiErrorMessage } from "./errors";

async function setTokenIfString(key: string, value: unknown) {
  if (typeof value === "string") await setTokenSecure(key, value);
}

export const fetchSecretKey = async () => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "액세스 토큰이 없습니다." };
  }

  try {
    const response = await axios.get(`${BACKEND_URL}/auth/secret-key`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const secret_key: string = response.data.secret_key;
    await setTokenSecure(USER_SECRET_KEY, secret_key);
    appendSystemLog({ event_name: "Login", log_type: "INFO", message: "secret key 요청 성공" });
    return { type: "success", message: "시크릿 키를 불러왔습니다." };
  } catch (error) {
    appendSystemLog({ event_name: "Login", log_type: "ERROR", message: `secret key 요청 실패: ${getApiErrorMessage(error)}` });
    return { type: "error", message: getApiErrorMessage(error) };
  }
};

export const verifyToken = async () => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.get(`${BACKEND_URL}/auth/verify`, {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 5000,
    });
    return { type: "success", message: response.data?.message ?? "토큰이 유효합니다." };
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      return { type: "no_response", message: "서버에 연결할 수 없습니다." };
    }
    return { type: "forbidden", message: getApiErrorMessage(error) };
  }
};

export const refreshToken = async () => {
  const refresh_token = await getTokenSecure(USER_REFRESH_TOKEN_KEY);
  if (!refresh_token) {
    return { type: "forbidden", message: "refresh token이 없습니다." };
  }

  try {
    const response = await axios.post(`${BACKEND_URL}/auth/refresh`, { refresh_token });
    const { access_token, refresh_token: new_refresh } = response.data as {
      access_token: string;
      refresh_token: string;
    };
    await setTokenSecure(USER_ACCESS_TOKEN_KEY, access_token);
    await setTokenSecure(USER_REFRESH_TOKEN_KEY, new_refresh);
    return { type: "success", message: "토큰이 갱신되었습니다." };
  } catch (error) {
    // 401/403만 세션이 무효라는 뜻이다. 네트워크 오류·5xx·429로 세션을 지우면 안 된다(interceptors.ts).
    const status = axios.isAxiosError(error) ? error.response?.status : undefined;
    return {
      type: status === 401 || status === 403 ? "forbidden" : "error",
      message: getApiErrorMessage(error),
    };
  }
};

// 카카오 콜백이 준 일회용 코드를 토큰으로 바꾼다. verifier는 로그인을 시작한 앱만 안다.
export const exchangeKakaoCode = async (code: string, verifier: string) => {
  try {
    const { data } = await axios.post(`${BACKEND_URL}/auth/kakao/exchange`, { code, verifier }, { timeout: 10000 });
    return {
      type: "success" as const,
      access_token: data.access_token as string,
      refresh_token: data.refresh_token as string,
      user_uuid: data.user_uuid as string,
    };
  } catch (error) {
    return { type: "error" as const, message: getApiErrorMessage(error) };
  }
};

export type InvitePreview = {
  device_uuid_prefix: string | null;
  device_nickname: string | null;
  role: string;
  display_name: string;
  inviter_name: string | null;
  expired_at: string | null;
  token_max_uses?: number | null;
  token_expire_minutes?: number | null;
  token_not_before?: string | null;
};

// GET /auth/invite-code/preview?invite_code=
export const fetchInvitePreview = async (invite_code: string) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "액세스 토큰이 없습니다." };
  }

  try {
    const response = await axios.get(
      `${BACKEND_URL}/auth/invite-code/preview?invite_code=${encodeURIComponent(invite_code)}`,
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    return { type: "success", data: response.data.data as InvitePreview };
  } catch (error) {
    return { type: "error", message: getApiErrorMessage(error) };
  }
};

export const fetchRegisterInviteCode = async (invite_code: String) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "액세스 토큰이 없습니다." };
  }

  try {
    const response = await axios.post(
      `${BACKEND_URL}/auth/join`,
      { invite_code: invite_code },
      { headers: { Authorization: `Bearer ${access_token}` } },
    );

    return { type: "success", message: response.data.message, device_uuid: response.data.data?.device_uuid as string | undefined };
  } catch (error) {
    return { type: "error", message: getApiErrorMessage(error) };
  }
};
