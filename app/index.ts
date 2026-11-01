// 앱 진입점. 백그라운드 등록(지오펜스 태스크, FCM·notifee 백그라운드 핸들러, 포그라운드 서비스 러너)을
// 라우트보다 먼저 전역에서 실행한다. 앱 프로세스가 죽은 상태에서 headless로 깨면 라우트는 로드되지 않는다.
import "react-native-get-random-values";
import "./lib/app-handlers";
import "expo-router/entry";
