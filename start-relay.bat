@echo off
chcp 65001 >nul
title Cowork Relay Worker - Home PC
color 0A
setlocal enabledelayedexpansion
echo.
echo =====================================================
echo   Cowork Relay Worker  (집 PC 전용)
echo =====================================================
echo.

:: Node.js 확인
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js가 설치되지 않았습니다.
  echo         https://nodejs.org 에서 설치하세요.
  pause & exit /b 1
)
for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%

:: Claude CLI PATH 보강 (npm global bin)
set PATH=%PATH%;%APPDATA%\npm
set PATH=%PATH%;%APPDATA%\npm\node_modules\.bin
set PATH=%PATH%;%LOCALAPPDATA%\Programs\claude
set PATH=%PATH%;%LOCALAPPDATA%\AnthropicClaude

:: claude 실행파일 검색
set CLAUDE_PATH=
for %%x in (claude.cmd claude.bat claude.exe) do (
  if not defined CLAUDE_PATH (
    for /f "tokens=*" %%p in ('where %%x 2^>nul') do (
      if not defined CLAUDE_PATH set CLAUDE_PATH=%%p
    )
  )
)

if defined CLAUDE_PATH (
  echo [OK] Claude CLI 발견: %CLAUDE_PATH%
) else (
  echo [WARN] PATH에서 Claude CLI를 찾지 못했습니다.
  echo        relay-worker.js 내부에서 재탐색합니다.
)

:: 작업 디렉토리 설정
set RELAY_DIR=%USERPROFILE%\CoworkRelay
if not exist "%RELAY_DIR%" (
  echo [INFO] %RELAY_DIR% 디렉토리 생성 중...
  mkdir "%RELAY_DIR%"
)
cd /d "%RELAY_DIR%"

:: relay-worker.js 다운로드 (항상 최신 버전)
echo [INFO] GitHub에서 최신 relay-worker.js 다운로드 중...
powershell -NoProfile -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/seongchun/remote-bridge/main/relay-worker.js' -OutFile 'relay-worker.js' -UseBasicParsing" >nul 2>nul
if errorlevel 1 (
  if exist relay-worker.js (
    echo [WARN] 다운로드 실패 - 기존 relay-worker.js 사용
  ) else (
    echo [ERROR] relay-worker.js 다운로드 실패 + 로컬 파일도 없음
    pause & exit /b 1
  )
) else (
  echo [OK] relay-worker.js 업데이트 완료
)

:: 자동 재시작 루프
echo.
echo [INFO] 릴레이 시작... (종료: Ctrl+C)
echo.

:restart
node relay-worker.js
echo.
echo [INFO] 릴레이 종료됨 - 3초 후 재시작...
timeout /t 3 /nobreak >nul
goto restart
