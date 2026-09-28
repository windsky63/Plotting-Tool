@echo off
setlocal

fsutil dirty query %systemdrive% >nul 2>&1
if errorlevel 1 (
  echo Requesting administrator permission for Windows Firewall...
  powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

netsh advfirewall firewall delete rule name="Luotu IDF Tool 3005" >nul 2>&1
netsh advfirewall firewall delete rule name="Luotu Production 3005" >nul 2>&1
netsh advfirewall firewall delete rule name="Luotu IDF Tool 3006" >nul 2>&1
netsh advfirewall firewall delete rule name="Luotu Support Chat 8788" >nul 2>&1

netsh advfirewall firewall add rule name="Luotu Production 3005" dir=in action=allow protocol=TCP localport=3005 profile=any
netsh advfirewall firewall add rule name="Luotu IDF Tool 3006" dir=in action=allow protocol=TCP localport=3006 profile=any
netsh advfirewall firewall add rule name="Luotu Support Chat 8788" dir=in action=allow protocol=TCP localport=8788 profile=private

echo.
echo Firewall rules installed for private networks.
echo Port 8789 remains local-only and is not opened.
pause
endlocal
