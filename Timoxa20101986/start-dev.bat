@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul || (echo Установите Node.js LTS: https://nodejs.org & pause & exit /b 1)
if not exist node_modules (call npm run setup) else (if not exist backend\node_modules call npm install --prefix backend & if not exist frontend\node_modules call npm install --prefix frontend)
call npm run dev
pause
