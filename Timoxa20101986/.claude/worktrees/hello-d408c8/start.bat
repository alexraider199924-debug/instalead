@echo off
chcp 65001 >nul
echo.
echo  InstaWorm - Instagram Outreach Platform
echo  ========================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo  ERROR: Node.js not found.
    echo  Download from: https://nodejs.org
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node -v') do set NODE_VER=%%i
echo  Node.js %NODE_VER% found.
echo.

:: Install backend deps
if not exist "backend\node_modules" (
    echo  Installing backend dependencies...
    cd backend
    npm install
    if %ERRORLEVEL% neq 0 (
        echo  ERROR: Failed to install backend dependencies.
        pause
        exit /b 1
    )
    cd ..
    echo  Backend dependencies installed.
    echo.
)

:: Install frontend deps
if not exist "frontend\node_modules" (
    echo  Installing frontend dependencies...
    cd frontend
    npm install
    if %ERRORLEVEL% neq 0 (
        echo  ERROR: Failed to install frontend dependencies.
        pause
        exit /b 1
    )
    cd ..
    echo  Frontend dependencies installed.
    echo.
)

echo  Starting Backend (port 3001)...
start "InstaWorm Backend" cmd /k "cd /d %~dp0backend && node src/index.js"

echo  Waiting for backend to start...
timeout /t 3 /nobreak >nul

echo  Starting Frontend (port 5173)...
start "InstaWorm Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

timeout /t 4 /nobreak >nul

echo.
echo  ========================================
echo   InstaWorm started successfully!
echo  ========================================
echo.
echo   Dashboard:  http://localhost:5173
echo   API:        http://localhost:3001
echo.
echo   Browser Extension setup:
echo   1. Open chrome://extensions
echo   2. Enable "Developer mode" (top right)
echo   3. Click "Load unpacked"
echo   4. Select the "extension" folder
echo.
echo  Opening dashboard in browser...
start http://localhost:5173

echo.
echo  Two windows opened (Backend + Frontend).
echo  Close them to stop InstaWorm.
echo.
pause
