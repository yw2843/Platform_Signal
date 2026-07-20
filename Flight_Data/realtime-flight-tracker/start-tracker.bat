@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_COMMAND="
where py >nul 2>nul
if not errorlevel 1 set "PYTHON_COMMAND=py -3"
if not defined PYTHON_COMMAND (
  where python >nul 2>nul
  if not errorlevel 1 set "PYTHON_COMMAND=python"
)

if not defined PYTHON_COMMAND (
  echo Python was not found on PATH.
  echo Install Python 3.10 or newer, then run this launcher again.
  pause
  exit /b 1
)

echo Starting the LGA Realtime Flight Tracker...
echo Open http://127.0.0.1:8000 after the server starts.
%PYTHON_COMMAND% server.py

if errorlevel 1 (
  echo.
  echo The tracker stopped with an error.
  pause
)

endlocal
