const { withAndroidManifest, withProjectBuildGradle } = require("expo/config-plugins");

const FOREGROUND_SERVICE = "app.notifee.core.ForegroundService";

/**
 * Expo config plugin to add Notifee Maven repository to Android build.gradle.
 * Required to resolve app.notifee:core for @notifee/react-native.
 * 또한 notifee 포그라운드 서비스 타입을 라이브러리 기본값(shortService, 약 3분 제한)에서 location으로 바꾼다.
 * BLE 트래킹 루프(tasks/bg-location.ts)가 최대 60분 이 서비스로 돈다.
 */
function withNotifee(config) {
  config = withProjectBuildGradle(config, (config) => {
    if (config.modResults.language === "groovy") {
      config.modResults.contents = addNotifeeMavenRepo(config.modResults.contents);
    }
    return config;
  });
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return config;
    manifest.$["xmlns:tools"] = manifest.$["xmlns:tools"] || "http://schemas.android.com/tools";

    const list = Array.isArray(application.service) ? application.service : application.service ? [application.service] : [];
    let service = list.find((s) => s.$?.["android:name"] === FOREGROUND_SERVICE);
    if (!service) {
      service = { $: { "android:name": FOREGROUND_SERVICE } };
      list.push(service);
      application.service = list;
    }
    service.$["android:foregroundServiceType"] = "location";
    service.$["tools:replace"] = "android:foregroundServiceType";
    return config;
  });
}

function addNotifeeMavenRepo(buildGradle) {
  if (buildGradle.includes("@notifee/react-native/android/libs")) {
    return buildGradle;
  }
  const notifeeRepo = `maven { url "$rootDir/../node_modules/@notifee/react-native/android/libs" }`;
  const pattern = /(allprojects\s*\{\s*repositories\s*\{)/;
  if (pattern.test(buildGradle)) {
    return buildGradle.replace(pattern, `$1\n    ${notifeeRepo}`);
  }
  return buildGradle;
}

module.exports = withNotifee;
