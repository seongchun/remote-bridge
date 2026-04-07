@echo off
chcp 65001 >nul
title Remote Bridge Relay Worker
color 0A

echo ================================================
echo   Remote Bridge Relay Worker - Home PC
echo ================================================
echo.
echo [INFO] Uses local Claude (Max plan) - no API key needed.
echo [INFO] Auto-restarts if relay crashes.
echo.

set RELAY_DIR=%USERPROFILE%\CoworkRelay
if exist "%RELAY_DIR%" goto dir_ok
echo [ERROR] %RELAY_DIR% not found.
echo Please run setup-home.bat first.
pause
exit /b 1

:dir_ok
cd /d "%RELAY_DIR%"

where node >nul 2>nul
if not errorlevel 1 goto node_ok
echo [ERROR] Node.js not found.
echo Please install from https://nodejs.org
pause
exit /b 1

:node_ok
where claude >nul 2>nul
if not errorlevel 1 goto claude_ok
echo [ERROR] Claude CLI not found.
echo Please install Claude Code first.
pause
exit /b 1

:claude_ok
echo [INFO] Downloading latest relay-worker.js from GitHub...
powershell -Command "Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/seongchun/remote-bridge/main/relay-worker.js' -OutFile 'relay-worker.js' -UseBasicParsing" >nul 2>nul
if errorlevel 1 (
  echo [WARN] Download failed - using existing relay-worker.js
) else (
  echo [OK] relay-worker.js updated.
)
echo.

echo [OK] Starting relay worker with auto-restart...
echo [INFO] Press Ctrl+C to stop.
echo.

:restart
echo [%date% %time%] Starting relay-worker.js...
node relay-worker.js
echo.
echo [%date% %time%] Relay worker stopped. Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto restart
