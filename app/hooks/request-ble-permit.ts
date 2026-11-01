import { showAlert } from "@/lib/alert";
import { AppState, PermissionsAndroid, Platform } from "react-native";

const blePermissions = () => {
  const apiLevel = parseInt(Platform.Version.toString(), 10);
  return apiLevel < 31
    ? [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION]
    : [
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ];
};

// 묻지 않고 확인만 한다. Activity가 없어도 되므로 백그라운드에서 쓴다.
export async function checkBluetoothPermission(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const results = await Promise.all(blePermissions().map((p) => PermissionsAndroid.check(p)));
  return results.every(Boolean);
}

export async function requestBluetoothPermission(): Promise<boolean> {
  if (Platform.OS === "ios") {
    return true;
  }
  if (
    Platform.OS === "android" &&
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
  ) {
    // 이미 허용돼 있으면 요청하지 않는다. 요청 API는 Activity가 있어야 해서 백그라운드에서 부르면 예외가 난다.
    if (await checkBluetoothPermission()) return true;
    if (AppState.currentState !== "active") return false;

    const apiLevel = parseInt(Platform.Version.toString(), 10);

    if (apiLevel < 31) {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    }
    if (
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN &&
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT
    ) {
      const result = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);

      return (
        result["android.permission.BLUETOOTH_CONNECT"] ===
          PermissionsAndroid.RESULTS.GRANTED &&
        result["android.permission.BLUETOOTH_SCAN"] ===
          PermissionsAndroid.RESULTS.GRANTED &&
        result["android.permission.ACCESS_FINE_LOCATION"] ===
          PermissionsAndroid.RESULTS.GRANTED
      );
    }
  }

  showAlert("Permission have not been granted");

  return false;
}
