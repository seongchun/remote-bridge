@echo off
chcp 65001 >nul
title Remote Bridge Agent - Cowork

set "REPO_DIR=%~dp0.."
set "POLL_INTERVAL=30"

where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Git required: https://git-scm.com/downloads
    pause & exit /b 1
)

echo ============================================
echo   Remote Bridge Agent
echo   Polling: %POLL_INTERVAL%s
echo   Close this window to stop
echo ============================================

cd /d "%REPO_DIR%"
git pull origin main --quiet 2>nul

:LOOP
echo [%date% %time%] Checking...
git pull origin main --quiet 2>nul

if exist "commands\pending\*.json" (
    for %%f in (commands\pending\*.json) do (
        echo [%date% %time%] Command: %%~nxf
        call :PROC "%%f"
    )
)

git add -A >nul 2>&1
git diff --cached --quiet 2>nul
if %ERRORLEVEL% neq 0 (
    echo [%date% %time%] Pushing...
    git commit -m "auto-sync [%date% %time%]" --quiet 2>nul
    git push origin main --quiet 2>nul
)

timeout /t %POLL_INTERVAL% /nobreak >nul
goto LOOP

:PROC
set "CF=%~1"
set "CN=%~n1"
for /f "delims=" %%a in ('powershell -NoProfile -Command "$j=Get-Content \"%CF%\" -Raw|ConvertFrom-Json;$j.action"') do set "ACT=%%a"
for /f "delims=" %%a in ('powershell -NoProfile -Command "$j=Get-Content \"%CF%\" -Raw|ConvertFrom-Json;$j.path"') do set "TGT=%%a"

echo [%date% %time%] Exec: %ACT% - %TGT%

if "%ACT%"=="read_file" (
    if exist "%TGT%" (
        copy "%TGT%" "results\%CN%.txt" >nul 2>&1
        echo {"status":"success","message":"read ok"} > "results\%CN%.status.json"
    ) else (
        echo {"status":"error","message":"not found"} > "results\%CN%.status.json"
    )
)
if "%ACT%"=="write_file" (
    powershell -NoProfile -Command "$j=Get-Content \"%CF%\" -Raw|ConvertFrom-Json;[IO.File]::WriteAllText($j.path,$j.content,[Text.Encoding]::UTF8)"
    echo {"status":"success","message":"write ok"} > "results\%CN%.status.json"
)
if "%ACT%"=="list_dir" (
    dir /b /a "%TGT%" > "results\%CN%.txt" 2>&1
    echo {"status":"success","message":"list ok"} > "results\%CN%.status.json"
)
if "%ACT%"=="run_cmd" (
    powershell -NoProfile -Command "$j=Get-Content \"%CF%\" -Raw|ConvertFrom-Json;cmd /c $j.path 2>&1|Out-File 'results\%CN%.txt' -Enc utf8"
    echo {"status":"success","message":"run ok"} > "results\%CN%.status.json"
)
if "%ACT%"=="copy_to_repo" (
    copy "%TGT%" "sync\" >nul 2>&1
    echo {"status":"success","message":"copy ok"} > "results\%CN%.status.json"
)

move "%CF%" "commands\completed\" >nul 2>&1
git add -A >nul 2>&1
git commit -m "result: %CN%" --quiet 2>nul
git push origin main --quiet 2>nul
goto :EOF