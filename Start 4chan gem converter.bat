@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 4chan gem converter needs Node.js 22 or newer. Install the LTS version from https://nodejs.org
  pause
  exit /b 1
)
if exist "%~dp0bin\ffmpeg.exe" set "FFMPEG_PATH=%~dp0bin\ffmpeg.exe"
if exist "%~dp0bin\ffprobe.exe" set "FFPROBE_PATH=%~dp0bin\ffprobe.exe"
node server.mjs
if errorlevel 1 pause
