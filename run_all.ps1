$ErrorActionPreference = 'Stop'

# 보드 모델(wifi | zigbee)과 보드 시리얼 포트. 모니터가 build_<model>\doorlock.elf로 크래시 주소를 해석한다.
$model   = 'zigbee'
$espPort = 'COM7'

function Encode($cmd) {
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
}

# Zigbee 모델용 MQTT 브로커 (Wi-Fi만 쓸 땐 없어도 된다)
docker compose -f 'C:\path\to\iot-app\docker-compose.dev.yml' up -d

$esp32Cmd = @'
Set-Location 'C:\path\to\iot-app\esp32'
$env:IDF_PATH = 'C:\esp\v6.0.1\esp-idf'
& 'C:\Espressif\tools\python\v6.0.1\venv\Scripts\python.exe' 'C:\esp\v6.0.1\esp-idf\tools\idf_monitor.py' -p __PORT__ -b 115200 --toolchain-prefix riscv32-esp-elf- --make "'C:\Espressif\tools\python\v6.0.1\venv\Scripts\python.exe' 'C:\esp\v6.0.1\esp-idf\tools\idf.py'" --target esp32c6 'C:\path\to\iot-app\esp32\build___MODEL__\doorlock.elf'
'@
$esp32Cmd = $esp32Cmd.Replace('__PORT__', $espPort).Replace('__MODEL__', $model)

$appCmd = @'
Set-Location 'C:\path\to\iot-app\app'
npx expo run:android
'@

$serverCmd = @'
Set-Location 'C:\path\to\iot-app\server'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
& 'C:\path\to\iot-app\server\.venv\Scripts\Activate.ps1'
python main.py
'@

# Zigbee 모델: 서버 MQTT 워커 + 개발 게이트웨이(Zigbee2MQTT + ZBDongle-P)
$workerCmd = @'
Set-Location 'C:\path\to\iot-app\server'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
& 'C:\path\to\iot-app\server\.venv\Scripts\Activate.ps1'
python mqtt_worker.py
'@

$z2mCmd = @'
Set-Location 'C:\path\to\iot-app\gateway\z2m'
npm start
'@

$esp32Enc  = Encode $esp32Cmd
$appEnc    = Encode $appCmd
$serverEnc = Encode $serverCmd
$workerEnc = Encode $workerCmd
$z2mEnc    = Encode $z2mCmd

Start-Process wt -ArgumentList @(
    '-p','grad-proj','powershell','-NoExit','-EncodedCommand',$esp32Enc,
    ';','split-pane','-V','-p','grad-proj','powershell','-NoExit','-EncodedCommand',$appEnc,
    ';','split-pane','-H','-p','grad-proj','powershell','-NoExit','-EncodedCommand',$serverEnc,
    ';','new-tab','-p','grad-proj','powershell','-NoExit','-EncodedCommand',$workerEnc,
    ';','split-pane','-V','-p','grad-proj','powershell','-NoExit','-EncodedCommand',$z2mEnc
)
