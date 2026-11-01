$ErrorActionPreference = 'Stop'

# 보드 모델(wifi | zigbee)과 보드 시리얼 포트. 모니터가 build_<model>\doorlock.elf로 크래시 주소를 해석한다.
$model   = 'zigbee'
$espPort = 'COM7'

# 저장소 경로는 이 스크립트 위치 기준. ESP-IDF가 기본 위치가 아니면 IDF_PATH, IDF_TOOLS_PATH를 설정한다.
$root     = $PSScriptRoot
$idfPath  = if ($env:IDF_PATH) { $env:IDF_PATH } else { 'C:\esp\v6.0.1\esp-idf' }
$idfTools = if ($env:IDF_TOOLS_PATH) { $env:IDF_TOOLS_PATH } else { 'C:\Espressif' }

function Encode($cmd) {
    $cmd = $cmd.Replace('__ROOT__', $root).Replace('__IDF_PATH__', $idfPath).Replace('__IDF_TOOLS__', $idfTools)
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
}

# Zigbee 모델용 MQTT 브로커 (Wi-Fi만 쓸 땐 없어도 된다)
docker compose -f (Join-Path $root 'docker-compose.dev.yml') up -d

$esp32Cmd = @'
Set-Location '__ROOT__\esp32'
$env:IDF_PATH = '__IDF_PATH__'
& '__IDF_TOOLS__\tools\python\v6.0.1\venv\Scripts\python.exe' '__IDF_PATH__\tools\idf_monitor.py' -p __PORT__ -b 115200 --toolchain-prefix riscv32-esp-elf- --make "'__IDF_TOOLS__\tools\python\v6.0.1\venv\Scripts\python.exe' '__IDF_PATH__\tools\idf.py'" --target esp32c6 '__ROOT__\esp32\build___MODEL__\doorlock.elf'
'@
$esp32Cmd = $esp32Cmd.Replace('__PORT__', $espPort).Replace('__MODEL__', $model)

$appCmd = @'
Set-Location '__ROOT__\app'
npx expo run:android
'@

$serverCmd = @'
Set-Location '__ROOT__\server'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
& '__ROOT__\server\.venv\Scripts\Activate.ps1'
python main.py
'@

# Zigbee 모델: 서버 MQTT 워커 + 개발 게이트웨이(Zigbee2MQTT + ZBDongle-P)
$workerCmd = @'
Set-Location '__ROOT__\server'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
& '__ROOT__\server\.venv\Scripts\Activate.ps1'
python mqtt_worker.py
'@

$z2mCmd = @'
Set-Location '__ROOT__\gateway\z2m'
npm start
'@

$esp32Enc  = Encode $esp32Cmd
$appEnc    = Encode $appCmd
$serverEnc = Encode $serverCmd
$workerEnc = Encode $workerCmd
$z2mEnc    = Encode $z2mCmd

Start-Process wt -ArgumentList @(
    'powershell','-NoExit','-EncodedCommand',$esp32Enc,
    ';','split-pane','-V','powershell','-NoExit','-EncodedCommand',$appEnc,
    ';','split-pane','-H','powershell','-NoExit','-EncodedCommand',$serverEnc,
    ';','new-tab','powershell','-NoExit','-EncodedCommand',$workerEnc,
    ';','split-pane','-V','powershell','-NoExit','-EncodedCommand',$z2mEnc
)
