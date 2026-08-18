@echo off
cd /d "%~dp0"
set "PATH=C:\Users\xjj20\.cargoin;%PATH%"
echo Starting Storyboard Copilot...
taskkill /F /IM storyboard-copilot.exe >/dev/null 2>&1
call npm run tauri dev
pause
