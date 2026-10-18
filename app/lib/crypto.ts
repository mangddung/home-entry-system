import CryptoJS from "crypto-js";

/**
 * BLE 인증 mac 계산 (서버 crypto_utils.ble_mac과 짝)
 * @param message nonce + auth_token
 * @param hexKey 서버와 공유하는 32글자(16바이트) Hex 키 (ble_encryption_key)
 * @returns HMAC-SHA256 결과 64글자 Hex 문자열
 */
export const hmacSha256 = (message: string, hexKey: string): string => {
  return CryptoJS.HmacSHA256(message, CryptoJS.enc.Hex.parse(hexKey)).toString(CryptoJS.enc.Hex);
};

/**
 * 문자열의 SHA-256 해시를 Hex 문자열로 반환
 */
export const sha256 = (data: string): string => {
  return CryptoJS.SHA256(data).toString(CryptoJS.enc.Hex);
};
