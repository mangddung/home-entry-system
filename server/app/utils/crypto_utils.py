import os
import json
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

def decrypt_data(master_kek: str, encrypted_key: str, encrypted_data: str) -> dict:
    """
    앱이 보낸 AES-CBC 암호문을 풀어서 원본 데이터를 반환하는 함수
    
    :param master_kek: secrets.yaml에서 가져온 HA 서버의 마스터 키
    :param encrypted_key_from_db: DB에서 조회한 해당 유저의 암호화된 BLE 대칭키
    :param encrypted_data_from_app: 앱에서 날아온 "IV + 암호문" 형태의 Hex 문자열
    :return: 딕셔너리 형태의 원본 데이터와 복호화된 BLE 키 (응답 암호화 시 재사용)
    """
    # 1. KEK로 BLE 대칭키의 진짜 모습(Hex)을 찾고 바이트(Bytes)로 변환
    f_kek = Fernet(master_kek)
    ble_key_hex = f_kek.decrypt(encrypted_key.encode()).decode('utf-8')
    ble_key_bytes = bytes.fromhex(ble_key_hex)

    # 2. 앱이 보낸 Hex 문자열을 바이트로 변환하고 IV와 암호문으로 분리
    encrypted_bytes = bytes.fromhex(encrypted_data)
    iv = encrypted_bytes[:16]        # 앞 16바이트는 IV
    ciphertext = encrypted_bytes[16:] # 나머지는 실제 암호문

    # 3. 표준 AES-CBC 복호화 실행
    cipher = Cipher(algorithms.AES(ble_key_bytes), modes.CBC(iv))
    decryptor = cipher.decryptor()
    padded_data = decryptor.update(ciphertext) + decryptor.finalize()

    # 4. PKCS7 언패딩 (더미 데이터 꼬리 자르기)
    pad_len = padded_data[-1]
    unpadded_data = padded_data[:-pad_len]

    # 5. JSON 파싱 후 BLE 키와 함께 반환
    parsed_data = json.loads(unpadded_data.decode('utf-8'))
    
    return {
        "data": parsed_data,
        "ble_key_bytes": ble_key_bytes # 암호화 응답시 사용
    }

def encrypt_data(payload_dict: dict, ble_key_bytes: bytes) -> str:
    """
    서버의 응답 데이터를 앱이 풀 수 있도록 AES-CBC로 암호화하는 함수
    
    :param payload_dict: 앱으로 보낼 딕셔너리 데이터 (예: {"otp": "123456"})
    :param ble_key_bytes: decrypt_client_data에서 얻은 16바이트 BLE 대칭키
    :return: "IV + 암호문" 형태의 Hex 문자열
    """
    payload_bytes = json.dumps(payload_dict).encode('utf-8')

    # 1. PKCS7 패딩 추가 (16바이트 배수로 맞추기)
    pad_len = 16 - (len(payload_bytes) % 16)
    padded_payload = payload_bytes + bytes([pad_len] * pad_len)

    # 2. 매번 새로운 랜덤 IV(16바이트) 생성 후 암호화
    iv = os.urandom(16)
    cipher = Cipher(algorithms.AES(ble_key_bytes), modes.CBC(iv))
    encryptor = cipher.encryptor()
    ciphertext = encryptor.update(padded_payload) + encryptor.finalize()

    # 3. IV와 암호문을 Hex 문자열로 예쁘게 합쳐서 반환
    return iv.hex() + ciphertext.hex()

def decrpyt_key(master_kek: str, encrypted_key: str):
    f_kek = Fernet(master_kek)
    return f_kek.decrypt(encrypted_key.encode()).decode('utf-8')
