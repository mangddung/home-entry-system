// 자동 인증 디버그 로그. 시스템 로그와 따로 지오펜스 → 활동(걸음) → BLE → 인증 → 서버 결과(푸시)를 한 파일에 시간순으로 남긴다.
// 형식: [yy-MM-dd HH:mm:ss.SSS][CATEGORY] 메시지
import { File, Paths } from "expo-file-system";

export const AUTH_LOG_FILE = "auto-auth-logs.txt";
export const AUTH_LOG_CATEGORIES = ["GEOFENCE", "ACTIVITY", "BLE", "AUTH", "SERVICE", "PUSH", "ERROR"] as const;
export type AuthLogCategory = (typeof AUTH_LOG_CATEGORIES)[number];

// 파일이 끝없이 커지지 않게 이 줄 수를 넘으면 최근 KEEP_LINES만 남긴다
const MAX_LINES = 3000;
const KEEP_LINES = 2000;

const stamp = (d: Date) => {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${String(d.getFullYear()).slice(-2)}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
};

// 기기 uuid 앞 8자리. 로그에서 기기를 구분하는 용도
export const short = (uuid: string) => uuid.slice(0, 8);

export function authLog(category: AuthLogCategory, message: string): void {
  try {
    const file = new File(Paths.document, AUTH_LOG_FILE);
    if (!file.exists) file.create();
    let text = file.textSync() + `[${stamp(new Date())}][${category}] ${message}\n`;
    const lines = text.split("\n");
    if (lines.length > MAX_LINES) text = lines.slice(-KEEP_LINES - 1).join("\n");
    file.write(text);
  } catch {
    // 디버그 로그 실패가 인증 흐름을 막으면 안 된다
  }
}

export function readAuthLogs(): string {
  const file = new File(Paths.document, AUTH_LOG_FILE);
  return file.exists ? file.textSync() : "";
}

export function clearAuthLogs(): void {
  const file = new File(Paths.document, AUTH_LOG_FILE);
  if (file.exists) file.delete();
}
