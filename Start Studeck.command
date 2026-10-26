#!/bin/bash
# Starts Studeck on a Mac (beta). Double-click it in Finder.
# (The first time, macOS may say it can't check the file: right-click it >
# Open > Open. Once it's running you can close this Terminal window.)
#
# The first time, it sets up Studeck's own Python add-ons in a ".venv" folder
# here (one time, needs the internet). That keeps them apart from the rest of
# your Mac, and works with Python from python.org or Homebrew alike.
cd "$(dirname "$0")" || exit 1

alert() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with title \"Studeck\"" >/dev/null 2>&1
}

new_enough() {
  "$1" -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >/dev/null 2>&1
}

# Studeck's environment, made with Python 3.10 or newer. (The python3 that comes
# with macOS is 3.9: too old.)
if ! new_enough .venv/bin/python; then
  PY=""
  for candidate in python3.14 python3.13 python3.12 python3.11 python3.10 \
      /Library/Frameworks/Python.framework/Versions/Current/bin/python3 \
      /opt/homebrew/bin/python3 /usr/local/bin/python3 python3; do
    path="$(command -v "$candidate" 2>/dev/null)" || continue
    [ "$path" = /usr/bin/python3 ] && continue  # macOS's own (3.9, and may ask to install developer tools)
    if new_enough "$path"; then PY="$path"; break; fi
  done
  if [ -z "$PY" ]; then
    echo "Studeck needs Python 3.10 or newer: https://www.python.org/downloads/"
    alert "Studeck needs Python 3.10 or newer. Install it from python.org (the page opens now), then double-click Start Studeck again."
    open "https://www.python.org/downloads/"
    exit 1
  fi
  echo "Setting up Studeck with $("$PY" --version 2>&1)..."
  rm -rf .venv
  "$PY" -m venv .venv || {
    alert "Could not set up Studeck's Python environment. See the Terminal window for details."
    exit 1
  }
fi

# The add-ons from requirements.txt, installed once.
if ! .venv/bin/python -c "import webview, pystray, PIL, icalendar, recurring_ical_events, certifi, AppKit, Quartz" >/dev/null 2>&1; then
  echo "Installing the add-ons Studeck needs. This happens once and takes a minute or two..."
  echo
  .venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt || {
    alert "Could not install the add-ons. Check your internet connection and try again. If it still fails, see the Terminal window for details."
    exit 1
  }
fi

nohup "$PWD/.venv/bin/python" dashboard.py >/dev/null 2>&1 &
disown
echo "Studeck is starting. Press Control+Option+D, or use its menu bar icon."
