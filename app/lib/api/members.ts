import axios from "axios";
import { BACKEND_URL, USER_ACCESS_TOKEN_KEY } from "../constants";
import { getTokenSecure } from "../token-storage";
import { getApiErrorMessage } from "./errors";

// POST /client/invite-code     body: { device_uuid, display_name }
export const createInviteCode = async (
  device_uuid: String,
  display_name: String,
  role: String,
  tokenOptions?: {
    token_max_uses?: number;
    token_expire_minutes?: number;
    token_not_before?: string;
  },
) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.post(
      `${BACKEND_URL}/client/invite-code`,
      { device_uuid: device_uuid, display_name: display_name, role: role, ...(tokenOptions ?? {}) },
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

// GET /client/invite-code?device_uuid=
export const fetchInviteCode = async (device_uuid: String) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.get(
      `${BACKEND_URL}/client/invite-code?device_uuid=${device_uuid}`,
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

// DELETE /client/invite-code?invite_code=
export const deleteInviteCode = async (invite_code: String) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.delete(
      `${BACKEND_URL}/client/invite-code?invite_code=${invite_code}`,
      { headers: { Authorization: `Bearer ${access_token}` }, timeout: 5000 },
    );
    return { type: "success", message: response.data.message };
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      return { type: "no_response", message: "서버에 연결할 수 없습니다." };
    }
    return { type: "forbidden", message: getApiErrorMessage(error) };
  }
};

// GET /client/member?device_uuid=
export const fetchMember = async (device_uuid: String) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.get(`${BACKEND_URL}/client/member?device_uuid=${device_uuid}`, {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 5000,
    });
    return { type: "success", data: response.data.data };
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      return { type: "no_response", message: "서버에 연결할 수 없습니다." };
    }
    return { type: "forbidden", message: getApiErrorMessage(error) };
  }
};

// DELETE /client/member?member_uuid=&device_uuid=
export const deleteMember = async (member_uuid: String, device_uuid: String) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.delete(
      `${BACKEND_URL}/client/member?member_uuid=${member_uuid}&device_uuid=${device_uuid}`,
      { headers: { Authorization: `Bearer ${access_token}` }, timeout: 5000 },
    );
    return { type: "success", message: response.data.message };
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      return { type: "no_response", message: "서버에 연결할 수 없습니다." };
    }
    return { type: "forbidden", message: getApiErrorMessage(error) };
  }
};

// POST /client/guest-token
export const createGuestToken = async (
  device_uuid: string,
  guest_uuid: string,
  max_uses?: number,
  not_before?: string,
  expire_minutes?: number,
  schedule?: { windows: { id: number; days: string[]; start: string; end: string; max_uses: number }[] },
  tz?: string,
) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.post(
      `${BACKEND_URL}/client/guest-token`,
      { device_uuid, guest_uuid, max_uses, not_before, expire_minutes, schedule, tz },
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

// GET /client/guest-token?device_uuid=&guest_uuid=
export const fetchGuestTokens = async (device_uuid: string, guest_uuid: string) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.get(
      `${BACKEND_URL}/client/guest-token?device_uuid=${device_uuid}&guest_uuid=${guest_uuid}`,
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

// DELETE /client/guest-token?device_uuid=&id=
export const deleteGuestToken = async (device_uuid: string, id: number) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.delete(
      `${BACKEND_URL}/client/guest-token?device_uuid=${device_uuid}&id=${id}`,
      { headers: { Authorization: `Bearer ${access_token}` }, timeout: 5000 },
    );
    return { type: "success", message: response.data.message };
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      return { type: "no_response", message: "서버에 연결할 수 없습니다." };
    }
    return { type: "forbidden", message: getApiErrorMessage(error) };
  }
};
