# IoT Smart Doorlock System (IoT 스마트 도어락 시스템)

이 프로젝트는 **ESP32 마이크로컨트롤러, Flask 백엔드 서버, React Native 모바일 앱**이 유기적으로 연동되는 **사용자 위치 및 블루투스(BLE) 기반의 스마트 도어락 솔루션**입니다.

---

## 1. 프로젝트 개요 (Overview)

본 시스템은 집안의 도어락 기기(ESP32)를 모바일 앱을 통해 블루투스(BLE) 혹은 외부 네트워크(Wi-Fi & Flask 서버 API)로 안전하게 제어하고 모니터링할 수 있도록 돕습니다. 사용자의 위치를 감지하여 도어락 근처에 도달하면 자동으로 제어하거나, 가족 구성원을 초대하여 함께 기기를 제어하고 실시간 푸시 알림(FCM)을 받아보는 등의 편의 기능을 제공합니다.

---

## 2. 핵심 기능 (Key Features)

*   **BLE 기반 기기 초기설정 (Provisioning)**
    *   미등록 상태인 도어락 기기(ESP32)가 BLE 신호를 송출하면, 모바일 앱에서 블루투스로 연결하여 주변 Wi-Fi 정보 및 기기 초기 설정 토큰을 안전하게 전송 및 주입합니다.
*   **하이브리드 제어 (원격 및 로컬 제어)**
    *   **로컬(BLE) 제어**: 인터넷 연결 상태가 불량하더라도 Bluetooth를 통해 근거리에서 즉시 도어락을 제어합니다.
    *   **원격(HTTP API) 제어**: 외부 네트워크에서 Flask 서버를 경유하여 기기 상태를 조회하고 원격 제어 명령을 내릴 수 있습니다.
*   **위치 기반 동작 및 백그라운드 관리**
    *   모바일 앱에서 기기의 위치(위도/경도)와 작동 반경을 설정하고, 사용자가 이 영역에 들어오거나 나갈 때 백그라운드 작업을 실행하여 스마트 제어를 지원합니다.
*   **초대 코드 및 멤버십 관리**
    *   마스터(Master) 권한의 사용자가 초대 코드를 생성하여 패밀리 멤버(Member/Guest)를 초대하고 권한을 관리할 수 있습니다.
*   **실시간 푸시 알림 (FCM)**
    *   도어락이 열리거나 닫힐 때, 또는 멤버가 그룹을 탈퇴하거나 기기 설정이 변경될 때 Firebase Cloud Messaging을 활용해 등록된 사용자 스마트폰으로 실시간 푸시 알림을 발송합니다.
*   **물리 인터페이스 (Factory Reset)**
    *   ESP32 기기의 물리 BOOT 버튼을 5초간 누르면 저장된 정보가 소거되며 공장 초기화 모드로 진입합니다.

---

## 3. 기술 스택 (Tech Stack)

### 📱 Mobile App (모바일 앱)
*   **Framework**: Expo 54 (React Native) + TypeScript
*   **Navigation**: Expo Router (File-based Routing)
*   **UI Library**: Ant Design React Native (`@ant-design/react-native`)
*   **Bluetooth**: `react-native-ble-plx`
*   **Push Notification**: `@react-native-firebase/messaging`, `expo-notifications`
*   **Location & Background**: `expo-location`, `expo-background-task`, `react-native-background-actions`

### 💻 Backend Server (백엔드 서버)
*   **Language & Framework**: Python 3, Flask
*   **Database ORM**: SQLAlchemy + PyMySQL (MySQL 연동)
*   **Authentication**: JWT (JSON Web Token) 및 카카오 OAuth 소셜 로그인
*   **Push Service**: Firebase Admin SDK (FCM)

### 🔌 IoT Device (ESP32 펌웨어)
*   **Framework**: ESP-IDF (C언어 기반 Native SDK)
*   **Peripherals**: Servo Motor (도어락 물리 개폐), LED Indicator, GPIO (BOOT 버튼)
*   **Communication**: BLE Server (초기 설정 및 로컬 제어용), Wi-Fi STA, HTTP Client (서버 통신)
*   **Storage**: NVS (Non-Volatile Storage) 플래시 메모리 보존

---

## 4. 디렉토리 구조 (Directory Structure)

```text
iot-app/
├── app/                  # React Native 모바일 앱 (Expo)
│   ├── app/              # Expo Router 페이지 구성 ((tabs), auth, device 등)
│   ├── components/       # 공통 UI 컴포넌트
│   ├── hooks/            # 커스텀 훅 (BLE, Location, API 통신 관련)
│   └── package.json      # 앱 의존성 및 스크립트 설정
│
├── server/               # Flask 기반 백엔드 API 서버
│   ├── app/              # 서버 핵심 비즈니스 로직
│   │   ├── routes/       # API 엔드포인트 (auth, client, iot, admin 등)
│   │   └── utils/        # 데이터베이스, FCM 발송, 로그 유틸리티
│   ├── main.py           # Flask 애플리케이션 진입점 (포트: 15895)
│   └── requirements.txt  # Python 라이브러리 의존성
│
└── esp32/                # ESP-IDF 기반 기기 펌웨어
    ├── main/             # 펌웨어 소스 코드
    │   ├── main.c        # 펌웨어 메인 엔드포인트 및 모드 분기
    │   ├── ble_server.c  # 블루투스 서버 구현
    │   ├── http_api.c    # 백엔드 서버와의 HTTP 클라이언트 통신
    │   └── servo_motor.c # 도어락 개폐 제어(서보 모터)
    └── CMakeLists.txt    # ESP-IDF 빌드 구성 파일
```

---

## 5. 실행 방식 및 설정 요약

### 백엔드 서버 (`/server`)
1. `.env.example` 파일을 바탕으로 `.env` 파일을 생성하고 데이터베이스 정보, Firebase SDK 경로 등을 설정합니다.
2. 의존성을 설치합니다: `pip install -r requirements.txt`
3. 서버를 실행합니다: `python main.py`

### 모바일 앱 (`/app`)
1. 의존성을 설치합니다: `npm install`
2. 개발 빌드 혹은 시뮬레이터로 실행합니다: `npm run android` 또는 `npm run ios`

### ESP32 펌웨어 (`/esp32`)
1. ESP-IDF 툴체인을 설정합니다.
2. `app_config.h.example`를 참고하여 `app_config.h` 파일을 작성하고 대상 서버 주소 등을 지정합니다.
3. 빌드 및 타겟 기기에 다운로드합니다.
