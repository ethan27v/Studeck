@echo off
rem Starts Studeck without a console window.
where pythonw >nul 2>nul || (
  echo Python was not found. Install Python 3 from the Microsoft Store or python.org, then try again.
  pause
  exit /b 1
)
start "" pythonw "%~dp0dashboard.py"
