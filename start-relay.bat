@echo off
chcp 65001 >/dev/null
title Remote Bridge Relay Worker
color 0A

echo.
echo ================================================
echo   Remote Bridge Relay Worker - Home PC
echo ================================================
echo.

:: ANTHROPIC API KEY CHECK
if "%ANTHROPIC_API_KEY%"=="" (
  echo [API KEY] ANTHROPIC_API_KEY is not set.
  set /p ANTHROPIC_API_KEY=  Enter API Key (sk-ant-...): 
  echo.
)

if "%ANTHROPIC_API_KEY%"=="" (
  echo [ERROR] No API Key entered. Exiting.
  pause
  exit /b 1
)

echo [OK] ANTHROPIC_API_KEY confirmed.
echo.

:: Check CoworkRelay directory
set RELAY_DIR=%USERPROFILE%\CoworkRelay
if not exist "%RELAY_DIR%" (
  echo [ERROR] %RELAY_DIR% not found.
  echo Please run setup-home.bat first.
  pause
  exit /b 1
)

cd /d "%RELAY_DIR%"

:: Open Bridge Dashboard
if exist "bridge-dashboard.html" (
  echo [INFO] Opening Bridge Dashboard...
  start "" "bridge-dashboard.html"
) else (
  echo [INFO] Dashboard not found. Opening GitHub Pages...
  start "" "https://seongchun.github.io/remote-bridge/bridge-dashboard.html"
)

:: Check Node.js
where node >/dev/null 2>/dev/null
if errorlevel 1 (
  echo [ERROR] Node.js not found.
  echo Please install from https://nodejs.org
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
echo [INFO] Press Ctrl+C to stop.
echo.

node relay-worker.js

echo.
echo [INFO] Relay Worker stopped.
pause
