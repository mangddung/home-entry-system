import axios from "axios";
import { BACKEND_URL, USER_ACCESS_TOKEN_KEY } from "../constants";
import { getTokenSecure } from "../token-storage";
import { getApiErrorMessage } from "./errors";

export type DeviceLog = {
  id: number;
  action: string;
  user_uuid: string | null;
  display_name: string | null;
  detail: string | null;
  created_at: string | null;
};

export const fetchDeviceLogs = async (
  device_uuid: string,
  category: "device" | "access" | "member",
) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) return { type: "forbidden" as const, message: "액세스 토큰이 없습니다." };

  try {
    const response = await axios.get(`${BACKEND_URL}/client/logs`, {
      headers: { Authorization: `Bearer ${access_token}` },
      params: { device_uuid, category },
      timeout: 10000,
    });
    return { type: "success" as const, data: response.data.data as DeviceLog[] };
  } catch (error) {
    return { type: "error" as const, message: getApiErrorMessage(error) };
  }
};
