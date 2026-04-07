@echo off
chcp 65001 >/dev/null
title Remote Bridge Relay Worker
color 0B

echo.
echo ================================================
echo   Remote Bridge Relay Worker - Home PC
echo ================================================
echo.

:: ─────────────────────────────────────────────────
::  ANTHROPIC API KEY%설정
:: 이 관이록 스화 있으면 건너뜁니다.
:: ─────────────────────────────────────────────────
if "%ANTHROPIC_API_KEY%"=="" (
  echo [API KEY] ANTHROPIC_API_KEY 가 설정되지 않았습니다.
  set /p ANTHROPIC_API_KEY=  API Key 입력 (sk-ant-...): 
  echo.
)

if "%ANTHROPIC_API_KEY%"=="" (
  echo [ERROR] API Key 를 입력하지 않았습니다. 종료합니다.
  pause
  exit /b 1
)

echo [OK] ANTHROPIC_API_KEY 확인됨.
echo.

:: CoworkRelay 폴더 확인
set RELAY_DIR=%USERPROFILE%\CoworkRelay
if not exist "%RELAY_DIR%" (
  echo [ERROR] %RELAY_DIR% 폴더가 없습니다.
  echo setup-home.bat 을 먼저 실행하세요.
  pause
  exit /b 1
)

cd /d "%RELAY_DIR%"

:: Bridge Dashboard 자동 오픈
if exist "bridge-dashboard.html" (
  echo [INFO] Bridge Dashboard 열는 중...
  start "" "bridge-dashboard.html"
) else (
  echo [INFO] Dashboard 파일 없음. GitHub Pages 에서 열기...
  start "" "https://seongchun.github.io/remote-bridge/bridge-dashboard.html"
)

:: Node.js 확인
where node >/dev/null 2>/dev/null
if errorlevel 1 (
  echo [ERROR] Node.js 가 설치되지 않았습니다.
  echo https://nodejs.org 에서 설치하세요.
  pause
  exit /b 1
)

:: relay-worker.js 확인
if not exist "relay-worker.js" (
  echo [ERROR] relay-worker.js 가 없습니다.
  pause
  exit /b 1
)

echo [INFO] Relay Worker 시작 중...
echo [INFO] 종료하려면 이 창을 닫거나 Ctrl+C 를 누르세요.
echo.

node relay-worker.js

echo.
echo [INFO] Relay Worker 종료됨.
pause
