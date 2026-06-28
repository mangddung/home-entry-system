import axios from "axios";

/** axios / 일반 Error / 기타 값을 사용자에게 보여줄 짧은 문장으로 정리 */
export function getApiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.code === "ECONNABORTED") {
      return "요청 시간이 초과되었습니다.";
    }
    if (error.response) {
      const data = error.response.data as { message?: string } | undefined;
      if (data?.message && typeof data.message === "string") {
        return data.message;
      }
      return `서버 오류 (${error.response.status})`;
    }
    if (error.request) {
      return "서버에 연결할 수 없습니다.";
    }
    return error.message || "요청에 실패했습니다.";
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 오류가 발생했습니다.";
}
