@echo off
cd /d "%~dp0"
set "PATH=C:\Users\xjj20\.cargo\bin;%PATH%"
echo Starting Storyboard Copilot...
taskkill /F /IM storyboard-copilot.exe >nul 2>&1
call npm run tauri dev
pause
