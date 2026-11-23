$ErrorActionPreference = 'Stop'

# run_all.ps1에서 서버 쪽(서버 + MQTT 워커 + Zigbee2MQTT)만 띄운다. 보드 모니터·앱 없음.
$root = $PSScriptRoot

function Encode($cmd) {
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd.Replace('__ROOT__', $root)))
}

# MQTT 브로커
docker compose -f (Join-Path $root 'docker-compose.dev.yml') up -d

$serverCmd = @'
Set-Location '__ROOT__\server'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned
& '__ROOT__\server\.venv\Scripts\Activate.ps1'
python main.py
'@

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

Start-Process wt -ArgumentList @(
    'powershell','-NoExit','-EncodedCommand',(Encode $serverCmd),
    ';','split-pane','-V','powershell','-NoExit','-EncodedCommand',(Encode $workerCmd),
    ';','split-pane','-H','powershell','-NoExit','-EncodedCommand',(Encode $z2mCmd)
)
