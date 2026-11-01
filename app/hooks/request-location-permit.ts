import { showAlert } from "@/lib/alert";
import { PermissionsAndroid, Platform } from "react-native";

// 묻지 않고 확인만 한다(설정에서 돌아왔을 때 재확인용). 지오펜스는 "항상 허용"이 필요하다.
export async function checkLocationPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;
  const fine = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  const coarse = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);
  if (!fine && !coarse) return false;
  if (Platform.Version < 29) return true;
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION);
}

export async function requestLocationPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") {
    return true;
  }

  try {
    // Step 1: Request foreground permissions FIRST
    const foregroundPermissions = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    ]);

    const foregroundGranted =
      foregroundPermissions["android.permission.ACCESS_FINE_LOCATION"] === "granted" ||
      foregroundPermissions["android.permission.ACCESS_COARSE_LOCATION"] === "granted";

    if (!foregroundGranted) {
      return false;
    }

    // Step 2: For Android 10+, request background permission SEPARATELY
    // On Android 11+, this MUST be a separate request with user education
    if (Platform.Version >= 29) {
      const alreadyGranted = await PermissionsAndroid.check(
        PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
      );
      if (alreadyGranted) return true;

      await new Promise<void>((resolve) => {
        showAlert(
          "Background Location Required",
          'To track your location when the app is in the background, please select "Allow all the time" on the next screen.',
          [{ text: "Continue", onPress: () => resolve() }],
        );
      });

      const backgroundPermission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_BACKGROUND_LOCATION,
      );

      return backgroundPermission === "granted";
    }

    return true;
  } catch (error) {
    console.error("Permission request failed:", error);
    return false;
  }
}
