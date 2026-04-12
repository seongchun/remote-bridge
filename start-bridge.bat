undefined@echo off
chcp 65001 > nul
title Supabase Bridge Agent v4
color 0B

echo ============================================================
echo   Supabase Bridge Agent v4 시작
echo   회사 PC에서 실행하세요
echo ============================================================
echo.

:: 1. 기존 브릿지 에이전트 종료 (단일 인스턴스이므로 새로 시작하면 자동 종료되지만 명시적으로)
echo [1/4] 기존 브릿지 에이전트 종료 중...
taskkill /F /FI "WINDOWTITLE eq Supabase Bridge Agent*" /T > nul 2>&1
:: bridge agent PS 스크립트 실행 중의 powershell 종료
for /f "tokens=2" %%P in ('wmic process where "commandline like '%%supabase-bridge-agent%%'" get processid 2^>nul ^| findstr /r "[0-9]"') do (
    echo   PID %%P 종료 중...
    taskkill /F /PID %%P > nul 2>&1
)
timeout /t 2 /nobreak > nul

:: 2. 최신 bridge agent 다운로드
echo [2/4] GitHub에서 최신 supabase-bridge-agent.ps1 다운로드 중...
set BRIDGE_DIR=%~dp0
set BRIDGE_FILE=%BRIDGE_DIR%supabase-bridge-agent.ps1

powershell -NoProfile -Command ^
  "try { Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/seongchun/remote-bridge/main/supabase-bridge-agent.ps1' -OutFile '%BRIDGE_FILE%' -UseBasicParsing; Write-Host '  다운로드 완료' } catch { Write-Host '  경고: 다운로드 실패 -' $_.Exception.Message }"

if not exist "%BRIDGE_FILE%" (
    echo   [오류] supabase-bridge-agent.ps1 파일을 찾을 수 없습니다.
    echo   수동으로 다운로드 후 같은 폴더에 놓으세요.
    pause
    exit /b 1
)

:: 3. PowerShell ExecutionPolicy 확인
echo [3/4] PowerShell 실행 정책 확인 중...
powershell -NoProfile -Command ^
  "try { $p=Get-ExecutionPolicy; Write-Host '  현재 정책:' $p; if($p -eq 'Restricted'){Write-Host '  [경고] Restricted 정책 - 스크립트를 실행하려면 Set-ExecutionPolicy RemoteSigned 필요' -ForegroundColor Yellow} } catch {}"

:: 4. 브릿지 에이전트 실행 (자동 재시작 루프)
echo [4/4] 브릿지 에이전트 시작...
echo.
echo ============================================================
echo   [Ctrl+C] 또는 창 닫기 = 종료
echo   회사 PC에서 실행 중 - 집 PC와 Supabase로 통신
echo ============================================================
echo.

:RESTART
echo [%DATE% %TIME%] 브릿지 에이전트 시작...
powershell -NoProfile -ExecutionPolicy Bypass -File "%BRIDGE_FILE%"
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
echo 브릿지 에이전트가 종료되었습니다.
pause
