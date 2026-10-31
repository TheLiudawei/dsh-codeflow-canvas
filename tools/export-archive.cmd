@echo off
setlocal
rem Double-click this file to build ../dsh-codeflow-canvas-1.0.1.zip.
rem -ExecutionPolicy Bypass is used only for this script; it does not change
rem the machine policy and it is not a permanent setting.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0export-archive.ps1"
set "CODE=%ERRORLEVEL%"
echo.
if not "%CODE%"=="0" echo Export failed with exit code %CODE%.
pause
endlocal & exit /b %CODE%
