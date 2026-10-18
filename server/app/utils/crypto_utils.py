import hashlib
import hmac
from cryptography.fernet import Fernet

def ble_mac(key_bytes: bytes, nonce: str, token_value: str) -> str:
    """
    BLE 인증 mac: HMAC-SHA256(사용자 BLE 키, nonce + auth_token)의 Hex 문자열 (앱 crypto.ts hmacSha256과 짝)
    토큰이 없는 사용자는 token_value=""로 계산한다.
    """
    return hmac.new(key_bytes, (nonce + token_value).encode('utf-8'), hashlib.sha256).hexdigest()

def decrpyt_key(master_kek: str, encrypted_key: str):
    f_kek = Fernet(master_kek)
    return f_kek.decrypt(encrypted_key.encode()).decode('utf-8')
