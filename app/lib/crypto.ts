import CryptoJS from "crypto-js";
import { getRandomBytes } from "expo-crypto";

/** IV는 CryptoJS.lib.WordArray.random 대신 Expo 네이티브 난수로 생성 (RN에서 crypto-js 난수 오류 방지) */
function randomIvWordArray(): CryptoJS.lib.WordArray {
  const bytes = getRandomBytes(16);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return CryptoJS.enc.Hex.parse(hex);
}

/**
 * 파이썬 서버와 통신하기 위한 암호화 함수
 * @param payload 암호화할 평문 데이터 (예: JSON.stringify 된 문자열)
 * @param hexKey 서버와 공유하는 32글자(16바이트) Hex 키 (ble_encryption_key)
 * @returns 32글자(IV) + 암호문이 합쳐진 Hex 문자열
 */
export const encryptAES = (payload: string, hexKey: string): string => {
  // 1. Hex 문자열 키를 CryptoJS가 이해할 수 있는 형식으로 변환
  const key = CryptoJS.enc.Hex.parse(hexKey);

  // 2. 매번 다르게 생성되는 16바이트 랜덤 IV(초기화 벡터) 생성
  const iv = randomIvWordArray();

  // 3. AES-CBC 모드로 암호화
  const encrypted = CryptoJS.AES.encrypt(payload, key, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  // 4. "IV(32글자) + 암호문(Hex)" 형태로 예쁘게 이어 붙여서 리턴
  const ivHex = iv.toString(CryptoJS.enc.Hex);
  const cipherHex = encrypted.ciphertext.toString(CryptoJS.enc.Hex);

  return ivHex + cipherHex;
};

/**
 * 파이썬 서버가 보낸 데이터를 복호화하는 함수
 * @param encryptedHex 서버가 보낸 "IV(32글자) + 암호문" 형태의 Hex 문자열
 * @param hexKey 서버와 공유하는 32글자(16바이트) Hex 키 (ble_encryption_key)
 * @returns 복호화된 원본 평문 문자열
 */
export const decryptAES = (encryptedHex: string, hexKey: string): string => {
  // 1. 키 변환
  const key = CryptoJS.enc.Hex.parse(hexKey);

  // 2. 서버가 보낸 데이터에서 앞 32글자(16바이트)는 IV, 나머지는 암호문으로 분리
  const ivHex = encryptedHex.substring(0, 32);
  const cipherHex = encryptedHex.substring(32);

  const iv = CryptoJS.enc.Hex.parse(ivHex);
  const ciphertext = CryptoJS.enc.Hex.parse(cipherHex);

  // 3. CryptoJS가 풀 수 있는 CipherParams 객체로 래핑
  const cipherParams = CryptoJS.lib.CipherParams.create({
    ciphertext: ciphertext,
  });

  // 4. 복호화 실행
  const decrypted = CryptoJS.AES.decrypt(cipherParams, key, {
    iv: iv,
    mode: CryptoJS.mode.CBC,
    padding: CryptoJS.pad.Pkcs7,
  });

  // 5. 풀린 데이터를 UTF-8 문자열로 변환하여 리턴
  return decrypted.toString(CryptoJS.enc.Utf8);
};

/**
 * 문자열의 SHA-256 해시를 Hex 문자열로 반환
 */
export const sha256 = (data: string): string => {
  return CryptoJS.SHA256(data).toString(CryptoJS.enc.Hex);
};
