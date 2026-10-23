@echo off
rem Starts Studeck without a console window. The first time, it installs the
rem add-ons it needs (one time, needs the internet).
cd /d "%~dp0"

rem A real Python 3.10+? (Windows' "python" shortcut to the Store doesn't count.)
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul || (
  echo Studeck needs Python 3.10 or newer.
  echo Install it from https://www.python.org/downloads/ ^(tick "Add python.exe to PATH"^)
  echo or from the Microsoft Store, then double-click this file again.
  pause
  exit /b 1
)

rem The add-ons from requirements.txt, installed once.
python -c "import webview, pystray, PIL, icalendar, recurring_ical_events, certifi" >nul 2>nul || (
  echo Installing the add-ons Studeck needs. This happens once and takes a minute or two...
  echo.
  python -m pip install --user --disable-pip-version-check -r requirements.txt || (
    echo.
    echo Could not install the add-ons. Check your internet connection and try again.
    echo If it still fails, open a terminal in this folder and run:
    echo     python -m pip install -r requirements.txt
    pause
    exit /b 1
  )
)

rem Start it with pythonw (no console window), from the same Python.
set "PYW="
for /f "delims=" %%P in ('python -c "import os, sys; print(os.path.join(os.path.dirname(sys.executable), 'pythonw.exe'))"') do set "PYW=%%P"
if not defined PYW set "PYW=pythonw"
if not exist "%PYW%" set "PYW=pythonw"
start "" "%PYW%" "%~dp0dashboard.py"
