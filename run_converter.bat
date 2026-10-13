@echo off
setlocal

cd /d "%~dp0"

echo ============================================================
echo 4chan WebM Converter
echo ============================================================
echo.

if not exist "%~dp0convert.ps1" (
    echo ERROR: convert.ps1 was not found in this folder.
    echo.
    pause
    exit /b 1
)

if not exist "%~dp0converter_config.txt" (
    echo ERROR: converter_config.txt was not found in this folder.
    echo.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0convert.ps1"

echo.
echo ============================================================
echo Converter finished.
echo ============================================================
echo.
pause
