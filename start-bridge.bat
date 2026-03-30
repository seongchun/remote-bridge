@echo off
chcp 65001 >nul
title Remote Bridge Agent - %COMPUTERNAME%
color 0A

echo.
echo  ================================================
echo    Remote Bridge Agent - One Click Launcher
echo    PC: %COMPUTERNAME%
echo  ================================================
echo.

:: Check if RemoteBridge folder exists
if not exist "C:\RemoteBridge\scripts" (
    echo [ERROR] C:\RemoteBridge\scripts folder not found.
    echo         Run setup-company.bat first.
    pause
    exit /b 1
)

cd /d C:\RemoteBridge

:: Check if bridge agent script exists
if not exist "scripts\supabase-bridge-agent.ps1" (
    echo [ERROR] supabase-bridge-agent.ps1 not found.
    pause
    exit /b 1
)

echo [INFO] Starting Bridge Agent...
echo [INFO] Press Ctrl+C or close this window to stop.
echo.

powershell -ExecutionPolicy Bypass -File "scripts\supabase-bridge-agent.ps1"

echo.
echo [INFO] Bridge Agent stopped.
pause
