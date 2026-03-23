@echo off
chcp 65001 >nul
title Remote Bridge Agent (API Mode)
echo Starting Remote Bridge Agent...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bridge-agent.ps1"
pause