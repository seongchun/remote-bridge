@echo off
chcp 65001 >nul
title Remote Bridge Relay Worker
color 0B

echo.
echo  ================================================
echo    Remote Bridge Relay Worker - Home PC
echo  ================================================
echo.

:: Check if CoworkRelay folder exists
set RELAY_DIR=%USERPROFILE%\CoworkRelay
if not exist "%RELAY_DIR%" (
    echo [ERROR] %RELAY_DIR% folder not found.
    echo         Run setup-home.bat first.
    pause
    exit /b 1
)

cd /d "%RELAY_DIR%"

:: Auto-open Bridge Dashboard in browser
if exist "bridge-dashboard.html" (
    echo [INFO] Opening Bridge Dashboard...
    start "" "bridge-dashboard.html"
) else (
    echo [INFO] Dashboard not found locally. Opening from GitHub...
    start "" "https://seongchun.github.io/remote-bridge/bridge-dashboard.html"
)

:: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed.
    echo         Install from https://nodejs.org
    pause
    exit /b 1
)

:: Check relay-worker.js
if not exist "relay-worker.js" (
    echo [ERROR] relay-worker.js not found.
    pause
    exit /b 1
)

echo [INFO] Starting Relay Worker...
echo [INFO] Press Ctrl+C or close this window to stop.
echo.

node relay-worker.js

echo.
echo [INFO] Relay Worker stopped.
pause
