@echo off
chcp 65001 > nul
title Remote Bridge Relay v34 - Self-Healing
color 0A

echo ============================================================
echo   Remote Bridge Relay Worker v34 자동 업데이트 시작
echo   집 PC에서 실행하세요
echo ============================================================
echo.

:: 1. 기존 relay-worker 프로세스 종료
echo [1/4] 기존 릴레이 프로세스 종료 중...
taskkill /F /FI "WINDOWTITLE eq Remote Bridge Relay*" /T > nul 2>&1
for /f "tokens=2" %%P in ('wmic process where "commandline like '%%relay-worker%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
    echo   PID %%P 종료 중...
    taskkill /F /PID %%P > nul 2>&1
)
del /f "%TEMP%\relay-worker.lock" > nul 2>&1
timeout /t 2 /nobreak > nul

:: 2. relay-worker.js 최신 버전 자동 다운로드 (항상 업데이트)
echo [2/4] GitHub에서 최신 relay-worker.js 다운로드 중...
set RELAY_DIR=%~dp0
set RELAY_FILE=%RELAY_DIR%relay-worker.js

powershell -NoProfile -Command ^
  "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/seongchun/remote-bridge/main/relay-worker.js' -OutFile '%RELAY_FILE%' -UseBasicParsing; Write-Host '  relay-worker.js 업데이트 완료!' } catch { Write-Host '  [경고] 다운로드 실패:' $_.Exception.Message }"

if not exist "%RELAY_FILE%" (
    echo   [오류] relay-worker.js를 찾을 수 없습니다. 인터넷 연결을 확인하세요.
    pause
    exit /b 1
)

:: 3. start-relay.bat 자기 자신도 최신 버전으로 교체 (다음 실행 시 반영)
echo [3/4] 최신 start-relay.bat 확인 중...
set BAT_TMP=%RELAY_DIR%start-relay.bat.new
powershell -NoProfile -Command ^
  "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/seongchun/remote-bridge/main/start-relay.bat' -OutFile '%BAT_TMP%' -UseBasicParsing; Write-Host '  start-relay.bat 업데이트 준비 완료' } catch { Write-Host '  [경고] bat 업데이트 건너뜀:' $_.Exception.Message }"
if exist "%BAT_TMP%" (
    move /y "%BAT_TMP%" "%RELAY_DIR%start-relay.bat" > nul 2>&1
    echo   start-relay.bat 교체 완료 (다음 실행 시 반영)
)

:: 4. node.js 확인
echo [4/4] Node.js 확인 중...
where node > nul 2>&1
if errorlevel 1 (
    echo   [오류] Node.js가 설치되지 않았습니다.
    echo   https://nodejs.org 에서 설치하세요.
    pause
    exit /b 1
)
for /f "tokens=*" %%V in ('node --version 2^>^&1') do echo   Node.js: %%V

:: 릴레이 실행 (자동 재시작 루프)
echo 릴레이 시작...
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
