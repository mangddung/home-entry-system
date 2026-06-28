import * as SecureStore from "expo-secure-store";
import {
  USER_ACCESS_TOKEN_KEY,
  USER_REFRESH_TOKEN_KEY,
  USER_UUID_KEY
} from "./constants";

export async function setTokenSecure(key: string, value: string): Promise<void> {
  return await SecureStore.setItemAsync(key, value);
}

export async function getTokenSecure(key: string): Promise<string | null> {
  return await SecureStore.getItemAsync(key);
}

export async function checkAuthToken(): Promise<boolean> {
  const userUuid = await getTokenSecure(USER_UUID_KEY);
  const userAccessToken = await getTokenSecure(USER_ACCESS_TOKEN_KEY);
  const userRefreshToken = await getTokenSecure(USER_REFRESH_TOKEN_KEY);

  return (
    userUuid !== null &&
    userUuid !== "" &&
    userAccessToken !== null &&
    userAccessToken !== "" &&
    userRefreshToken !== null &&
    userRefreshToken !== ""
  );
}
