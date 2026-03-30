@echo off
chcp 65001 >nul
title Remote Bridge Agent - %COMPUTERNAME%
color 0A

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║   Remote Bridge Agent - One Click Launcher   ║
echo  ║   PC: %COMPUTERNAME%                         ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: Check if RemoteBridge folder exists
if not exist "C:\RemoteBridge\scripts" (
    echo [ERROR] C:\RemoteBridge\scripts 폴더를 찾을 수 없습니다.
    echo         먼저 setup-company.bat를 실행해주세요.
    pause
    exit /b 1
)

cd /d C:\RemoteBridge

:: Check if bridge agent script exists
if not exist "scripts\supabase-bridge-agent.ps1" (
    echo [ERROR] supabase-bridge-agent.ps1 파일을 찾을 수 없습니다.
    pause
    exit /b 1
)

echo [INFO] Bridge Agent 시작 중...
echo [INFO] 종료하려면 이 창을 닫거나 Ctrl+C를 누르세요.
echo.

powershell -ExecutionPolicy Bypass -NoProfile -File "C:\RemoteBridge\scripts\supabase-bridge-agent.ps1"

echo.
echo [INFO] Bridge Agent가 종료되었습니다.
pause
