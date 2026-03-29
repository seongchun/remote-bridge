@echo off
chcp 65001 >nul 2>&1
title Remote Bridge - Home PC Setup
color 0B
echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║   Remote Bridge - Home PC One-Click Setup        ║
echo  ║   집 PC 원클릭 설치                              ║
echo  ╚══════════════════════════════════════════════════╝
echo.

set "GITHUB_RAW=https://raw.githubusercontent.com/seongchun/remote-bridge/main"
set "INSTALL_DIR=%USERPROFILE%\CoworkRelay"

:: ─────────────────────────────────────────────
:: 0. Check prerequisites
:: ─────────────────────────────────────────────
echo  [0/5] Checking prerequisites...

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo  !! Node.js not found !!
  echo  Please install Node.js first:
  echo    1. Go to https://nodejs.org
  echo    2. Download LTS version
  echo    3. Install and restart this script
  echo.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo        Node.js: %%v - OK

where claude >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo  !! Claude CLI not found !!
  echo  Installing Claude CLI...
  call npm install -g @anthropic-ai/claude-code
  if %ERRORLEVEL% NEQ 0 (
    echo  FAILED. Please run manually:
    echo    npm install -g @anthropic-ai/claude-code
    pause
    exit /b 1
  )
  echo.
  echo  Claude CLI installed. Now authenticate:
  echo    Run: claude auth
  echo    Then restart this script.
  echo.
  pause
  exit /b 0
)
for /f "tokens=*" %%v in ('claude --version 2^>nul') do echo        Claude CLI: %%v - OK

:: ─────────────────────────────────────────────
:: 1. Create directory
:: ─────────────────────────────────────────────
echo.
echo  [1/5] Creating directory...
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
echo        OK - %INSTALL_DIR%

:: ─────────────────────────────────────────────
:: 2. Download relay worker from GitHub
:: ─────────────────────────────────────────────
echo.
echo  [2/5] Downloading relay worker from GitHub...

powershell -ExecutionPolicy Bypass -Command ^
  "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; ^
   $base='%GITHUB_RAW%'; ^
   try { ^
     (New-Object Net.WebClient).DownloadFile(\"$base/relay-worker.js\", '%INSTALL_DIR%\relay-worker.js'); ^
     Write-Host '        OK: relay-worker.js' ^
   } catch { ^
     Write-Host '        FAIL: relay-worker.js' -ForegroundColor Red; ^
     exit 1 ^
   }"

:: ─────────────────────────────────────────────
:: 3. Create start script
:: ─────────────────────────────────────────────
echo.
echo  [3/5] Creating start script...

(
echo @echo off
echo title Cowork Relay Worker
echo chcp 65001 ^>nul 2^>^&1
echo.
echo where node ^>nul 2^>^&1
echo if %%ERRORLEVEL%% NEQ 0 ^(
echo     echo [ERROR] Node.js not found
echo     pause
echo     exit /b 1
echo ^)
echo.
echo where claude ^>nul 2^>^&1
echo if %%ERRORLEVEL%% NEQ 0 ^(
echo     echo [ERROR] Claude CLI not found
echo     pause
echo     exit /b 1
echo ^)
echo.
echo echo [OK] Node.js + Claude CLI found
echo echo Starting Relay Worker...
echo echo.
echo.
echo :loop
echo pushd "%%~dp0"
echo node relay-worker.js
echo popd
echo echo.
echo echo [WARN] Worker stopped. Restarting in 5s...
echo timeout /t 5 /nobreak ^>nul
echo goto loop
) > "%INSTALL_DIR%\start-relay.bat"

echo        OK: start-relay.bat

:: ─────────────────────────────────────────────
:: 4. Register auto-start
:: ─────────────────────────────────────────────
echo.
echo  [4/5] Setting up auto-start on login...

powershell -ExecutionPolicy Bypass -Command ^
  "try { ^
     $startup=[Environment]::GetFolderPath('Startup'); ^
     $shell=New-Object -ComObject WScript.Shell; ^
     $lnk=$shell.CreateShortcut(\"$startup\CoworkRelay.lnk\"); ^
     $lnk.TargetPath='%INSTALL_DIR%\start-relay.bat'; ^
     $lnk.WorkingDirectory='%INSTALL_DIR%'; ^
     $lnk.Save(); ^
     Write-Host '        OK - Auto-start registered' ^
   } catch { Write-Host '        SKIP - failed (not critical)' }"

:: ─────────────────────────────────────────────
:: 5. Start relay worker
:: ─────────────────────────────────────────────
echo.
echo  [5/5] Starting relay worker...
echo.
echo  ╔══════════════════════════════════════════════════╗
echo  ║   HOME PC SETUP COMPLETE!                        ║
echo  ╠══════════════════════════════════════════════════╣
echo  ║                                                  ║
echo  ║   Install dir: %INSTALL_DIR%                     ║
echo  ║   Start:       start-relay.bat                   ║
echo  ║   Auto-start:  registered (on login)             ║
echo  ║                                                  ║
echo  ║   Starting relay worker now...                   ║
echo  ║   Press Ctrl+C to stop                           ║
echo  ║                                                  ║
echo  ╚══════════════════════════════════════════════════╝
echo.

cd /d "%INSTALL_DIR%"
node relay-worker.js
echo.
echo  Worker stopped. Press any key to restart...
pause >nul
goto :eof
