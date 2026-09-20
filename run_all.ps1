$ErrorActionPreference = 'Stop'

function Encode($cmd) {
    [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
}

$esp32Cmd = @'
Set-Location 'C:\path\to\iot-app\esp32'
$env:IDF_PATH = 'C:\esp\v6.0.1\esp-idf'
& 'C:\Espressif\tools\python\v6.0.1\venv\Scripts\python.exe' 'C:\esp\v6.0.1\esp-idf\tools\idf_monitor.py' -p COM4 -b 115200 --toolchain-prefix riscv32-esp-elf- --make "'C:\Espressif\tools\python\v6.0.1\venv\Scripts\python.exe' 'C:\esp\v6.0.1\esp-idf\tools\idf.py'" --target esp32c6 'C:\path\to\iot-app\esp32\build\doorlock.elf'
'@

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

$esp32Enc  = Encode $esp32Cmd
$appEnc    = Encode $appCmd
$serverEnc = Encode $serverCmd

Start-Process wt -ArgumentList @(
    '-p','grad-proj','powershell','-NoExit','-EncodedCommand',$esp32Enc,
    ';','split-pane','-V','-p','grad-proj','powershell','-NoExit','-EncodedCommand',$appEnc,
    ';','split-pane','-H','-p','grad-proj','powershell','-NoExit','-EncodedCommand',$serverEnc
)