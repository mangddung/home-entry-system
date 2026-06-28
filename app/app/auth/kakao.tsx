import * as WebBrowser from "expo-web-browser";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";

// openAuthSessionAsync가 브라우저를 닫고 결과 URL을 반환하도록 신호를 보냄
// 실제 code 처리는 login_oauth.tsx의 openAuthSessionAsync result에서 수행
WebBrowser.maybeCompleteAuthSession();

export default function KakaoOAuthCallback() {
  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#3A1D1D" />
      <Text style={styles.text}>카카오 로그인 처리 중...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#FEE500",
    gap: 16,
  },
  text: {
    fontSize: 15,
    fontWeight: "600",
    color: "#3A1D1D",
  },
});
