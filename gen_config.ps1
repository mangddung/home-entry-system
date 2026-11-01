# ESP-IDF 도구가 기본 위치가 아니면 IDF_TOOLS_PATH를 설정한다.
$idfTools = if ($env:IDF_TOOLS_PATH) { $env:IDF_TOOLS_PATH } else { 'C:\Espressif' }
Set-Location (Join-Path $PSScriptRoot 'esp32')
. (Join-Path $idfTools 'tools\Microsoft.v6.0.1.PowerShell_profile.ps1')
python generate_config.py
Read-Host "끝, 엔터 눌러 종료"
