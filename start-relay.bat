@echo off
chcp 65001 > nul
title Remote Bridge Relay v30
color 0A

echo ============================================================
echo   Remote Bridge Relay Worker v30 시작
echo   집 PC에서 실행하세요
echo ============================================================
echo.

:: 1. 기존 relay-worker.js 프로세스 종료
echo [1/4] 기존 릴레이 프로세스 종료 중...
taskkill /F /FI "WINDOWTITLE eq Remote Bridge Relay*" /T > nul 2>&1
:: relay-worker.js를 실행 중의 node.exe 찾아서 종료
for /f "tokens=2" %%P in ('wmic process where "commandline like '%%relay-worker%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
    echo   PID %%P 종료 중...
    taskkill /F /PID %%P > nul 2>&1
)
:: 락 파일 삭제
del /f "%TEMP%\relay-worker.lock" > nul 2>&1
timeout /t 2 /nobreak > nul

:: 2. 최신 relay-worker.js 다운로드
echo [2/4] GitHub에서 최신 relay-worker.js 다운로드 중...
set RELAY_DIR=%~dp0
set RELAY_FILE=%RELAY_DIR%relay-worker.js

powershell -NoProfile -Command ^
  "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/seongchun/remote-bridge/main/relay-worker.js' -OutFile '%RELAY_FILE%' -UseBasicParsing; Write-Host '  다운로드 완료' } catch { Write-Host '  경고: 다운로드 실패 -' $_.Exception.Message }"

if not exist "%RELAY_FILE%" (
    echo   [오류] relay-worker.js 파일을 찾을 수 없습니다.
    echo   수동으로 다운로드 후 같은 폴더에 놓으세요:
    echo   https://raw.githubusercontent.com/seongchun/remote-bridge/main/relay-worker.js
    pause
    exit /b 1
)

:: 3. node.js 확인
echo [3/4] Node.js 확인 중...
where node > nul 2>&1
if errorlevel 1 (
    echo   [오류] Node.js가 설치되지 않았습니다.
    echo   https://nodejs.org 에서 설치하세요.
    pause
    exit /b 1
)
for /f "tokens=*" %%V in ('node --version 2^>^&1') do echo   Node.js: %%V

:: 4. 릴레이 실행 (자동 재시작 루프)
echo [4/4] 릴레이 시작...
echo.
echo ============================================================
echo   [Ctrl+C] 또는 창 닫기 = 종료
echo ============================================================
echo.

:RESTART
echo [%DATE% %TIME%] 릴레이 시작...
node "%RELAY_FILE%"
set EXIT_CODE=%errorlevel%

if %EXIT_CODE% == 0 (
    echo.
    echo [%DATE% %TIME%] 정상 종료
    goto END
)

echo.
echo [%DATE% %TIME%] 비정상 종료 (코드=%EXIT_CODE%) - 5초 후 재시작...
timeout /t 5 /nobreak > nul
goto RESTART

:END
echo.
echo 릴레이가 종료되었습니다.
pause
