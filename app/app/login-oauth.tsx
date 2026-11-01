import { Colors } from "@/constants/theme";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { showAlert } from "@/lib/alert";
import { exchangeKakaoCode, fetchSecretKey } from "@/lib/api/auth";
import { fetchFcmToken } from "@/lib/api/fcm";
import {
  BACKEND_URL,
  USER_ACCESS_TOKEN_KEY,
  USER_REFRESH_TOKEN_KEY,
  USER_UUID_KEY,
} from "@/lib/constants";
import { sha256 } from "@/lib/crypto";
import { appendSystemLog } from "@/lib/system-log";
import { setTokenSecure } from "@/lib/token-storage";
import axios from "axios";
import * as Crypto from "expo-crypto";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

WebBrowser.maybeCompleteAuthSession();

type KakaoConfig = { client_id: string; redirect_uri: string };

function KakaoLoginButton({ onPress, loading }: { onPress: () => void; loading: boolean }) {
  return (
    <TouchableOpacity
      style={loading && styles.kakaoButtonDisabled}
      onPress={onPress}
      activeOpacity={0.8}
      disabled={loading}
    >
      {loading ? (
        <View style={styles.kakaoLoadingBox}>
          <ActivityIndicator size="small" color="#3A1D1D" />
          <Text style={styles.kakaoButtonText}>로그인 중...</Text>
        </View>
      ) : (
        <Image
          source={require("@/assets/images/kakao_login_medium_wide.png")}
          style={styles.kakaoImage}
          resizeMode="contain"
        />
      )}
    </TouchableOpacity>
  );
}

export default function LoginOAuthScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? "light"];
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [kakaoConfig, setKakaoConfig] = useState<KakaoConfig | null>(null);

  const getConfig = async () => {
    try {
      const url = `${BACKEND_URL}/auth/kakao/config`;
      const res = await axios.get<KakaoConfig>(url, { timeout: 5000 });
      setKakaoConfig(res.data);
      appendSystemLog({ event_name: "Login", log_type: "INFO", message: "kakao config 요청 성공" });
    } catch (e) {
      console.error("[kakao_config] error=", e);
      appendSystemLog({ event_name: "Login", log_type: "ERROR", message: `kakao config 요청 실패: ${e}` });
      showAlert("서버 통신 실패", "카카오 로그인 설정을 불러오지 못했습니다.");
    }
  };

  useEffect(() => {
    void (async () => {
      await getConfig();
    })();
  }, []);

  const handleKakaoLogin = async () => {
    if (!kakaoConfig) {
      await getConfig();
      return;
    }

    setLoading(true);
    appendSystemLog({ event_name: "Login", log_type: "INFO", message: "카카오 로그인 시작" });
    try {
      // verifier는 앱만 안다. 돌아온 state가 다르면 내가 시작한 로그인이 아니고,
      // 코드를 가로챈 쪽은 verifier가 없어 토큰으로 바꿀 수 없다.
      const verifier = Array.from(Crypto.getRandomBytes(32), (b) => b.toString(16).padStart(2, "0")).join("");
      const state = sha256(verifier);
      const authUrl =
        `https://kauth.kakao.com/oauth/authorize` +
        `?client_id=${kakaoConfig.client_id}` +
        `&redirect_uri=${encodeURIComponent(kakaoConfig.redirect_uri)}` +
        `&response_type=code` +
        `&state=${state}`;

      const result = await WebBrowser.openAuthSessionAsync(authUrl, "iotapp://login_oauth");

      if (result.type === "cancel" || result.type === "dismiss") {
        appendSystemLog({ event_name: "Login", log_type: "INFO", message: "카카오 로그인 취소" });
        return;
      }

      if (result.type !== "success") {
        appendSystemLog({ event_name: "Login", log_type: "WARNING", message: `카카오 인증 세션 실패: ${result.type}` });
        showAlert("오류", "로그인 중 오류가 발생했습니다.(코드 101)");
        router.replace("/login-oauth");
        return;
      }

      const resultUrl = new URL(result.url);
      const error = resultUrl.searchParams.get("error");
      const code = resultUrl.searchParams.get("code");

      if (error || !code || resultUrl.searchParams.get("state") !== state) {
        appendSystemLog({ event_name: "Login", log_type: "ERROR", message: `카카오 로그인 콜백 오류: ${error ?? "코드·state 불일치"}` });
        showAlert("로그인 실패", error ?? "인증에 실패했습니다.");
        return;
      }

      const tokens = await exchangeKakaoCode(code, verifier);
      if (tokens.type !== "success") {
        appendSystemLog({ event_name: "Login", log_type: "ERROR", message: `로그인 코드 교환 실패: ${tokens.message}` });
        showAlert("로그인 실패", "인증에 실패했습니다.");
        return;
      }

      await setTokenSecure(USER_ACCESS_TOKEN_KEY, tokens.access_token);
      await setTokenSecure(USER_REFRESH_TOKEN_KEY, tokens.refresh_token);
      await setTokenSecure(USER_UUID_KEY, tokens.user_uuid);

      // secret key 요청
      const key_request_result = await fetchSecretKey();

      if (key_request_result.type !== "success") {
        appendSystemLog({ event_name: "Login", log_type: "ERROR", message: "secret key 요청 실패로 로그인 중단" });
        showAlert("오류", "로그인 중 오류가 발생했습니다.(코드 102)");
        router.replace("/login-oauth");
        return;
      }
      await fetchFcmToken();

      appendSystemLog({ event_name: "Login", log_type: "INFO", message: "카카오 로그인 완료" });
      router.replace("/(tabs)/home");
    } catch (e) {
      appendSystemLog({ event_name: "Login", log_type: "ERROR", message: `로그인 처리 중 예외: ${e}` });
      showAlert("오류", "로그인 중 오류가 발생했습니다.(100)");
      router.replace("/login-oauth");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.logoArea}>
        <Text style={[styles.appTitle, { color: colors.text }]}>도어락 모듈 프로젝트</Text>
        <Text style={[styles.appSubtitle, { color: colors.icon }]}>IoT 앱</Text>
      </View>

      <View style={styles.buttonArea}>
        <KakaoLoginButton onPress={handleKakaoLogin} loading={loading} />
        <TouchableOpacity style={styles.debugButton} onPress={() => router.push("/debug")}>
          <Text style={[styles.debugButtonText, { color: colors.icon }]}>Debug Login</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  logoArea: {
    alignItems: "center",
    marginBottom: 64,
  },
  appTitle: {
    fontSize: 32,
    fontWeight: "700",
    letterSpacing: -0.5,
  },
  appSubtitle: {
    fontSize: 14,
    marginTop: 8,
  },
  buttonArea: {
    width: "100%",
    maxWidth: 360,
  },
  kakaoButtonDisabled: {
    opacity: 0.7,
  },
  kakaoImage: {
    width: "100%",
    height: 54,
  },
  kakaoLoadingBox: {
    backgroundColor: "#FEE500",
    borderRadius: 12,
    height: 54,
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 10,
  },
  kakaoButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#000000CC",
    letterSpacing: -0.2,
  },
  footer: {
    marginTop: 32,
  },
  footerLink: {
    fontSize: 13,
    color: "#888",
    textDecorationLine: "underline",
  },
  debugButton: {
    marginTop: 16,
    alignSelf: "center",
  },
  debugButtonText: {
    fontSize: 13,
    textDecorationLine: "underline",
  },
});
