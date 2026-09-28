@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start_remote_workstation.ps1"
if errorlevel 1 pause
endlocal

