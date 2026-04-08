@echo off
chcp 65001 >nul
title Cowork Relay Worker
color 0A

echo.
echo =====================================================
echo   Cowork Relay Worker  (Home PC)
echo =====================================================
echo.

:: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_VER=%%v
echo [OK] Node.js %NODE_VER%

:: Add npm global bin to PATH so claude.cmd can be found
set PATH=%PATH%;%APPDATA%\npm
set PATH=%PATH%;%APPDATA%\npm\node_modules\.bin
set PATH=%PATH%;%LOCALAPPDATA%\Programs\claude
set PATH=%PATH%;%LOCALAPPDATA%\AnthropicClaude

:: Find claude executable
set CLAUDE_PATH=
for %%x in (claude.cmd claude.bat claude.exe) do (
  if not defined CLAUDE_PATH (
    for /f "tokens=*" %%p in ('where %%x 2^>nul') do (
      if not defined CLAUDE_PATH set CLAUDE_PATH=%%p
    )
  )
)

if defined CLAUDE_PATH (
  echo [OK] Claude CLI: %CLAUDE_PATH%
) else (
  echo [WARN] Claude CLI not found in PATH. relay-worker will retry.
  echo [HINT] Run: where claude  - to find the path
  echo [HINT] Then: set CLAUDE_PATH=full-path-to-claude.cmd
)

:: Create working directory if needed
if not exist "%USERPROFILE%\CoworkRelay" (
  echo [INFO] Creating CoworkRelay folder...
  mkdir "%USERPROFILE%\CoworkRelay"
)
cd /d "%USERPROFILE%\CoworkRelay"

:: Check Python (required for markitdown file extraction)
where python >nul 2>nul
if errorlevel 1 (
  where python3 >nul 2>nul
  if errorlevel 1 (
    echo [WARN] Python not found - file extraction will not work
    echo Install from https://python.org
  )
)

:: Check/Install markitdown
echo [Check] markitdown...
pip show markitdown >nul 2>nul
if errorlevel 1 (
  echo [Install] Installing markitdown for office file extraction...
  pip install markitdown --quiet 2>nul
  if errorlevel 1 (
    python -m pip install markitdown --quiet 2>nul
    if errorlevel 1 (
      echo [WARN] markitdown install failed - office file extraction may not work
    )
  )
) else (
  echo [OK] markitdown installed
)

:: Download latest relay-worker.js from GitHub
echo [INFO] Downloading latest relay-worker.js...
powershell -NoProfile -Command "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/seongchun/remote-bridge/main/relay-worker.js' -OutFile 'relay-worker.js' -UseBasicParsing; Write-Host '[OK] relay-worker.js updated' } catch { Write-Host '[WARN] Download failed, using cached version' }"

if not exist relay-worker.js (
  echo [ERROR] relay-worker.js not found.
  pause
  exit /b 1
)

:: Auto-restart loop
echo.
echo [INFO] Starting relay... (Ctrl+C to stop)
echo.

:restart
node relay-worker.js
echo.
echo [INFO] Relay stopped. Restarting in 3 seconds...
timeout /t 3 /nobreak >nul
goto restart
