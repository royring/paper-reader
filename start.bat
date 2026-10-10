@echo off
cd /d "%~dp0"
rem Paper Reader launcher: server runs in this console window (Ctrl+C or close to stop)
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found in PATH. Please install Python 3.
  pause
  exit /b 1
)
echo Starting Paper Reader ...
python server.py
echo.
echo Server exited. See messages above for errors.
pause
