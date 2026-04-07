@echo off
chcp 65001 >nul
title Remote Bridge Relay Worker
color 0A
echo.
echo ================================================
echo   Remote Bridge Relay Worker - Home PC
echo ================================================
echo.
echo [INFO] Uses local Claude (Max plan) - no API key needed.
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
echo Please install Claude Code from https://claude.ai/download
pause
exit /b 1

:claude_ok
if exist "relay-worker.js" goto run
echo [ERROR] relay-worker.js not found.
pause
exit /b 1

:run
echo [OK] Starting Relay Worker...
echo [INFO] Press Ctrl+C to stop.
echo.
node relay-worker.js
echo.
echo [INFO] Relay Worker stopped.
pause
