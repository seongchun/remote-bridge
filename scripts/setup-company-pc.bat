@echo off
chcp 65001 >nul
title Remote Bridge Setup

echo ============================================
echo   Remote Bridge - Company PC Setup
echo ============================================

where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Git required: https://git-scm.com/downloads
    pause & exit /b 1
)

set /p "DIR=Install path (default C:\RemoteBridge): "
if "%DIR%"=="" set "DIR=C:\RemoteBridge"
set /p "URL=GitHub repo URL: "

git clone "%URL%" "%DIR%"
cd /d "%DIR%"
git config user.name "company-pc-agent"
git config user.email "agent@company.local"

powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell;$sc=$ws.CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Bridge Agent.lnk');$sc.TargetPath='%DIR%\scripts\bridge-agent.bat';$sc.WorkingDirectory='%DIR%';$sc.Save()"

set /p "AUTO=Auto-start on boot? (y/n): "
if /i "%AUTO%"=="y" (
    powershell -NoProfile -Command "$ws=New-Object -ComObject WScript.Shell;$sc=$ws.CreateShortcut([Environment]::GetFolderPath('Startup')+'\Bridge Agent.lnk');$sc.TargetPath='%DIR%\scripts\bridge-agent.bat';$sc.WorkingDirectory='%DIR%';$sc.WindowStyle=7;$sc.Save()"
    echo [OK] Added to startup
)

echo.
echo [Done] Run 'Bridge Agent' on desktop.
pause