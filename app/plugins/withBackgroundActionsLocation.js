const { withAndroidManifest } = require("@expo/config-plugins");

const SERVICE_NAME = "com.asterinet.react.bgactions.RNBackgroundActionsTask";

/** Android 14+ 크래시 방지: 앱 매니페스트에 서비스 선언 + foregroundServiceType 추가 (Gradle 병합 시 라이브러리 서비스와 합쳐짐) */
function withBackgroundActionsLocation(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    const application = manifest.application?.[0];
    if (!application) return config;

    const services = application.service;
    const list = Array.isArray(services) ? services : services ? [services] : [];

    const existing = list.find((s) => (s.$?.["android:name"] || "").includes("RNBackgroundActionsTask"));
    if (existing?.$) {
      existing.$["android:foregroundServiceType"] = "location";
    } else {
      list.push({
        $: {
          "android:name": SERVICE_NAME,
          "android:foregroundServiceType": "location",
        },
      });
      application.service = list;
    }
    return config;
  });
}

module.exports = withBackgroundActionsLocation;
