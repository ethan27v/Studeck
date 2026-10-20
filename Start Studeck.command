#!/bin/bash
# Starts Studeck on a Mac (beta). Double-click it in Finder.
# (The first time, macOS may say it can't check the file: right-click it >
# Open > Open. Once it's running you can close this Terminal window.)
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  osascript -e 'display dialog "Python 3 was not found. Install it from python.org, then try again." buttons {"OK"} default button 1 with title "Studeck"'
  exit 1
fi
if ! python3 -c "import webview, pystray, icalendar, AppKit" >/dev/null 2>&1; then
  echo "Installing the add-ons the dashboard needs (one time)..."
  python3 -m pip install --user -r requirements.txt || {
    osascript -e 'display dialog "Could not install the add-ons. Open Terminal in this folder and run:  python3 -m pip install -r requirements.txt" buttons {"OK"} default button 1 with title "Studeck"'
    exit 1
  }
fi
nohup python3 dashboard.py >/dev/null 2>&1 &
disown
echo "Studeck is starting. Press Control+Option+D, or use its menu bar icon."
