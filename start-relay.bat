@echo off
chcp 65001 >nul
title Remote Bridge Relay Worker
color 0A

echo.
echo ================================================
echo   Remote Bridge Relay Worker - Home PC
echo ================================================
echo.

if not "%ANTHROPIC_API_KEY%"=="" goto key_ok
echo [API KEY] ANTHROPIC_API_KEY is not set.
set /p ANTHROPIC_API_KEY=  Enter API Key (sk-ant-...): 
echo.

if not "%ANTHROPIC_API_KEY%"=="" goto key_ok
echo [ERROR] No API Key entered. Exiting.
pause
exit /b 1

:key_ok
echo [OK] ANTHROPIC_API_KEY confirmed.
echo.

set RELAY_DIR=%USERPROFILE%\CoworkRelay
if exist "%RELAY_DIR%" goto dir_ok
echo [ERROR] %RELAY_DIR% not found.
echo Please run setup-home.bat first.
pause
exit /b 1

:dir_ok
cd /d "%RELAY_DIR%"

if exist "bridge-dashboard.html" goto open_local
start "" "https://seongchun.github.io/remote-bridge/bridge-dashboard.html"
goto check_node
:open_local
start "" "bridge-dashboard.html"

:check_node
where node >nul 2>nul
if not errorlevel 1 goto node_ok
echo [ERROR] Node.js not found.
echo Please install from https://nodejs.org
pause
exit /b 1

:node_ok
if exist "relay-worker.js" goto run_relay
echo [ERROR] relay-worker.js not found.
pause
exit /b 1

:run_relay
echo [INFO] Starting Relay Worker...
echo [INFO] Press Ctrl+C to stop.
echo.

node relay-worker.js

echo.
echo [INFO] Relay Worker stopped.
pause
