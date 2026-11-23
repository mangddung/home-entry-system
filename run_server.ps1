$ErrorActionPreference = 'Stop'

# run_all.ps1에서 서버 쪽(서버 + MQTT 워커 + Zigbee2MQTT)만 띄운다. 보드 모니터·앱 없음.
$root = $PSScriptRoot

function Encode($cmd) {
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd.Replace('__ROOT__', $root)))
}

# MQTT 브로커. docker compose는 진행 상황을 stderr로 쓰는데 PS 5.1은 'Stop'에서 이를 오류로 보고 멈추므로
# cmd에서 stderr를 합쳐 실행하고 종료 코드로만 판단한다.
cmd /c "docker compose -f `"$(Join-Path $root 'docker-compose.dev.yml')`" up -d 2>&1"
# 파일에 BOM이 없어 PS 5.1이 한글 문자열을 깨뜨리므로 출력 메시지는 영어로 둔다
if ($LASTEXITCODE -ne 0) { throw "Failed to start the MQTT broker. Check that Docker Desktop is running." }

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
