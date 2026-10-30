# PyInstaller build for the packaged app (no Python needed to run it).
#
#   python -m pip install -r requirements.txt pyinstaller
#   python -m PyInstaller studeck.spec --noconfirm
#
# Windows: dist/Studeck/Studeck.exe (keep the whole Studeck folder together)
# Mac:     dist/Studeck.app
# The GitHub release workflow (.github/workflows/release.yml) runs the same thing.

import os
import sys

IS_MAC = sys.platform == "darwin"
VERSION = os.environ.get("STUDECK_VERSION", "0.0.0").lstrip("v")

# The pages, sounds and icons the app loads at runtime.
PAGES = ["index.html", "app.js", "importer.js", "styles.css", "data.js", "settings.html", "settings.js",
         "summary.html", "review.html", "mini.html", "toast.html"]
ICONS = ["studeck.ico", "studeck.icns", "studeck.png", "tray.png"]
datas = [(name, ".") for name in PAGES]
datas += [(os.path.join("icons", name), "icons") for name in ICONS]
datas += [("sounds", "sounds")]

# pystray picks its backend at runtime, so PyInstaller can't see it.
hiddenimports = ["pystray._darwin"] if IS_MAC else ["pystray._win32"]

a = Analysis(
    ["dashboard.py"],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Studeck",
    console=False,
    icon=os.path.join("icons", "studeck.icns" if IS_MAC else "studeck.ico"),
)
coll = COLLECT(exe, a.binaries, a.datas, name="Studeck")

if not IS_MAC:
    # Files unzipped from a downloaded zip are marked "from the internet", and .NET
    # then won't load the app's own DLLs ("Failed to resolve
    # Python.Runtime.Loader.Initialize"). This lets it load them anyway; the app
    # also clears the mark itself on start-up (unblock_downloaded_files).
    with open(os.path.join(DISTPATH, "Studeck", "Studeck.exe.config"), "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n'
                "<configuration>\n"
                "  <runtime>\n"
                '    <loadFromRemoteSources enabled="true"/>\n'
                "  </runtime>\n"
                "</configuration>\n")

if IS_MAC:
    app = BUNDLE(
        coll,
        name="Studeck.app",
        icon=os.path.join("icons", "studeck.icns"),
        bundle_identifier="com.studeck.app",
        version=VERSION,
        info_plist={
            "CFBundleShortVersionString": VERSION,
            "LSUIElement": True,  # a menu bar app: no Dock icon
            "NSHighResolutionCapable": True,
            "NSAppleEventsUsageDescription": "Studeck shows and controls what's playing in Spotify or Music.",
        },
    )
