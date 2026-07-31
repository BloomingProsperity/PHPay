@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy.ps1"
if errorlevel 1 (
  echo.
  echo PHPay deployment failed. Check Docker Desktop and the message above.
  pause
  exit /b 1
)
endlocal
