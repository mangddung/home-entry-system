const { withProjectBuildGradle } = require("expo/config-plugins");

/**
 * Expo config plugin to add Notifee Maven repository to Android build.gradle.
 * Required to resolve app.notifee:core for @notifee/react-native.
 */
function withNotifee(config) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language === "groovy") {
      config.modResults.contents = addNotifeeMavenRepo(config.modResults.contents);
    }
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
