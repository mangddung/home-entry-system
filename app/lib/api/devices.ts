import axios from "axios";
import { router } from "expo-router";
import {
  BACKEND_URL,
  DEVICE_SETUP_KEY,
  DEVICE_STATUS_KEY,
  UNFIGURED_DEVICES_KEY,
  USER_ACCESS_TOKEN_KEY,
  USER_DEVICES_KEY,
} from "../constants";
import { getTokenSecure, setTokenSecure } from "../token-storage";
import type { DeviceStatus, IoTDevice, SetupUuids } from "../types";
import { getApiErrorMessage } from "./errors";

export const fetchDevices = async () => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "액세스 토큰이 없습니다." };
  }

  try {
    const response = await axios.get(`${BACKEND_URL}/client/devices`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const devices: IoTDevice[] = response.data.data;
    await setTokenSecure(USER_DEVICES_KEY, JSON.stringify(devices));

    // device status 업데이트
    const storedDeviceStatus: string | null = await getTokenSecure(DEVICE_STATUS_KEY);
    const parsedDeviceStatus: DeviceStatus[] = storedDeviceStatus
      ? JSON.parse(storedDeviceStatus)
      : [];

    const existingUuids = new Set(parsedDeviceStatus.map((s) => s.device_uuid));
    const deviceUuids = new Set(devices.map((d) => d.device_uuid));

    // 없으면 추가
    for (const device of devices) {
      if (!existingUuids.has(device.device_uuid)) {
        parsedDeviceStatus.push({
          device_uuid: device.device_uuid,
          isInside: false,
          bleSuccess: false,
        });
      }
    }

    // 디바이스 목록에 없으면 삭제
    const updatedStatus = parsedDeviceStatus.filter((s) => deviceUuids.has(s.device_uuid));
    await setTokenSecure(DEVICE_STATUS_KEY, JSON.stringify(updatedStatus));

    return { type: "success", message: "디바이스 목록을 불러왔습니다." };
  } catch (error) {
    return { type: "error", message: getApiErrorMessage(error) };
  }
};

export const fetchSetupUuid = async () => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "액세스 토큰이 없습니다." };
  }

  try {
    const response = await axios.get(`${BACKEND_URL}/client/setup-uuid`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const setup_uuids: SetupUuids[] = response.data.data;
    await setTokenSecure(DEVICE_SETUP_KEY, JSON.stringify(setup_uuids));
    return { type: "success", message: "setup uuid fetch 성공" };
  } catch (error) {
    return { type: "error", message: getApiErrorMessage(error) };
  }
};

export const fetchDeviceSetupToken = async (device_uuid: any) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "액세스 토큰이 없습니다." };
  }
  try {
    const response = await axios.post(
      `${BACKEND_URL}/client/setup-token`,
      { device_uuid: device_uuid },
      { headers: { Authorization: `Bearer ${access_token}` } },
    );
    const data = response.data.data;
    const setup_token = data.setup_token;
    return setup_token;
  } catch (error) {
    return { type: "error", message: getApiErrorMessage(error) };
  }
};

export const fetchUnconfiguredDevices = async () => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "액세스 토큰이 없습니다." };
  }
  try {
    const response = await axios.get(`${BACKEND_URL}/client/unfigured-devices`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const data = response.data.data;

    await setTokenSecure(UNFIGURED_DEVICES_KEY, JSON.stringify(data));
    return { type: "success", message: "success" };
  } catch (error) {
    return { type: "error", message: getApiErrorMessage(error) };
  }
};

export const fetchDeviceLocation = async (
  dev_uuid: string,
  lat: number,
  long: number,
  range: number,
  nickname: string,
) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "액세스 토큰이 없습니다." };
  }
  try {
    const response = await axios.post(
      `${BACKEND_URL}/client/device-location`,
      {
        device_uuid: dev_uuid,
        latitude: lat,
        longitude: long,
        range_meter: range,
        device_nickname: nickname,
      },
      { headers: { Authorization: `Bearer ${access_token}` } },
    );

    const data = response.data.data;
    router.push("/home");
    return { type: "success", message: "success" };
  } catch (error) {
    return { type: "error", message: getApiErrorMessage(error) };
  }
};

// DELETE /client/device
export const deleteDevice = async (device_uuid: String) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.delete(`${BACKEND_URL}/client/device?device_uuid=${device_uuid}`, {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 5000,
    });
    return { type: "success", message: response.data.message };
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      return { type: "no_response", message: "서버에 연결할 수 없습니다." };
    }
    return { type: "forbidden", message: getApiErrorMessage(error) };
  }
};

// DELETE /client/device-membership
export const deleteMemberShip = async (device_uuid: String) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.delete(
      `${BACKEND_URL}/client/device-membership?device_uuid=${device_uuid}`,
      {
        headers: { Authorization: `Bearer ${access_token}` },
        timeout: 5000,
      },
    );
    return { type: "success", message: response.data.message };
  } catch (error) {
    if (axios.isAxiosError(error) && !error.response) {
      return { type: "no_response", message: "서버에 연결할 수 없습니다." };
    }
    return { type: "forbidden", message: getApiErrorMessage(error) };
  }
};

// POST /client/device-name
export const updateDeviceName = async (device_uuid: String, device_nickname: String) => {
  const access_token = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  if (!access_token) {
    return { type: "forbidden", message: "access token이 없습니다." };
  }

  try {
    const response = await axios.post(
      `${BACKEND_URL}/client/device-name`,
      { device_uuid: device_uuid, device_nickname: device_nickname },
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
