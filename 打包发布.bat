@echo off
cd /d "%~dp0"
set "PATH=C:\Users\xjj20\.cargo\bin;%PATH%"
echo ================================
echo  Storyboard Copilot
echo ================================
echo  [1] Dev mode  (npm run tauri dev)
echo  [2] Build     (npm run tauri build)
echo  [3] Release   (npm run release -- patch)
echo.
set /p choice=Select (1/2/3):
if "%choice%"=="1" goto dev
if "%choice%"=="2" goto build
if "%choice%"=="3" goto release
echo Invalid option
pause
exit /b 1
:dev
taskkill /F /IM storyboard-copilot.exe >nul 2>&1
call npm run tauri dev
goto done
:build
taskkill /F /IM storyboard-copilot.exe >nul 2>&1
call npm run tauri build
if errorlevel 1 (echo Build failed & pause & exit /b 1)
echo  Build OK: src-tauri\target\release\bundle
goto done
:release
echo  Ensure docs/releases/vX.Y.Z.md is ready
taskkill /F /IM storyboard-copilot.exe >nul 2>&1
call npm run release -- patch
if errorlevel 1 (echo Release failed & pause & exit /b 1)
echo  Release OK!
goto done
:done
echo.
echo Done.
pause
