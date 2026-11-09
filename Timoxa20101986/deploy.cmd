@echo off
rem  ============================================================
rem   One-click deploy for Instalead. Double-click this file.
rem   pack -> upload -> install -> build -> restart -> check
rem
rem   deploy.cmd          full deploy (server setup + release + TLS)
rem   deploy.cmd fix      quick redeploy: staging build + auto rollback
rem
rem   Keeps working on the server SSH key if one exists, otherwise
rem   asks for the root password once.
rem
rem   ASCII only on purpose: cmd.exe reads .cmd files in the console
rem   OEM codepage, and UTF-8 text here turns into mojibake.
rem  ============================================================

setlocal
cd /d "%~dp0"

set "SCRIPT=deploy.ps1"
if /i "%~1"=="fix" set "SCRIPT=deploy-fix.ps1"

if not exist "%SCRIPT%" (
  echo.
  echo [FAIL] %SCRIPT% not found next to this file:
  echo        %CD%
  pause
  exit /b 1
)

echo.
echo === Deploying via %SCRIPT% ===
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [OK] Deployed. Site: https://instalead.ru
) else (
  echo [FAIL] Deploy did not finish, exit code %RC%.
  echo        Logs: ssh root@147.45.243.151 "journalctl -u instalead-backend -n 50"
)

pause
exit /b %RC%