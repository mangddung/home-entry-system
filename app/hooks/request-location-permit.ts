import { Alert, PermissionsAndroid, Platform } from "react-native";

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
        Alert.alert(
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
