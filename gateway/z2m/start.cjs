// Zigbee2MQTT 실행: 데이터 폴더를 이 디렉터리의 data/로 고정한다(설치 폴더 안 node_modules/zigbee2mqtt/data가 아니라).
// Z2M index.js는 직접 실행(main 모듈)될 때만 시작하므로 require가 아니라 자식 프로세스로 띄운다.
// GIT_DIR: Z2M은 git 커밋 해시로 자기 빌드가 최신인지 본다. 이 폴더가 iot-app 저장소 안이라 우리 저장소 해시를
// 읽고 pnpm 재빌드를 시도하므로, git을 못 찾게 해 npm 패키지에 들어 있는 빌드를 그대로 쓰게 한다.
const {spawn} = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Z2M은 외부 컨버터 폴더에 node_modules 링크(junction)를 만드는데, npm이 의존성을 위로 끌어올려(hoist)
// 링크 대상(node_modules/zigbee2mqtt/node_modules)이 없어 링크가 끊긴다. 끊긴 링크가 남으면 다음 실행에서
// EEXIST로 컨버터 로드가 실패하므로 시작 전에 지운다(모듈 해석은 상위 node_modules로 된다).
const link = path.join(__dirname, "data", "external_converters", "node_modules");
try {
    if (fs.lstatSync(link).isSymbolicLink()) fs.unlinkSync(link);
} catch (e) {
    if (e.code !== "ENOENT") throw e;
}

const child = spawn(process.execPath, [require.resolve("zigbee2mqtt/index.js")], {
    stdio: "inherit",
    env: {...process.env, ZIGBEE2MQTT_DATA: path.join(__dirname, "data"), GIT_DIR: path.join(__dirname, ".no-git")},
});
child.on("exit", (code) => process.exit(code ?? 1));
