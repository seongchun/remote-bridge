@echo off
chcp 65001 >nul
title Remote Bridge Relay Worker
color 0B

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║   Remote Bridge Relay Worker - Home PC       ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: Check if CoworkRelay folder exists
set RELAY_DIR=%USERPROFILE%\CoworkRelay
if not exist "%RELAY_DIR%" (
    echo [ERROR] %RELAY_DIR% 폴더를 찾을 수 없습니다.
    echo         먼저 setup-home.bat를 실행해주세요.
    pause
    exit /b 1
)

cd /d "%RELAY_DIR%"

:: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js가 설치되어 있지 않습니다.
    echo         https://nodejs.org 에서 설치해주세요.
    pause
    exit /b 1
)

:: Check relay-worker.js
if not exist "relay-worker.js" (
    echo [ERROR] relay-worker.js 파일을 찾을 수 없습니다.
    pause
    exit /b 1
)

echo [INFO] Relay Worker 시작 중...
echo [INFO] 종료하려면 이 창을 닫거나 Ctrl+C를 누르세요.
echo.

node relay-worker.js

echo.
echo [INFO] Relay Worker가 종료되었습니다.
pause
