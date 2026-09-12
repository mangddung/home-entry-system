// https://<domain>/invite?code=... 및 iotapp://invite?code=... 을
// expo-router 파일 경로(/register_invite_code)로 옮긴다.
export function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  try {
    const url = new URL(path, "https://local");
    if (url.pathname === "/invite") {
      const code = url.searchParams.get("code");
      return code
        ? `/register_invite_code?code=${encodeURIComponent(code)}`
        : "/register_invite_code";
    }
  } catch {
    // 파싱 실패 시 원본 경로를 그대로 넘긴다.
  }
  return path;
}
