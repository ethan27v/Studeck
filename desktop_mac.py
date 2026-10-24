"""
Mac side of the dashboard (beta): the same small set of methods as
desktop_win.py, built on AppKit/Quartz (pyobjc), the Carbon hotkey API and a
LaunchAgent for "Open at login".

On a Mac the top edge of the screen is the menu bar, so the dashboard opens
with Ctrl+Option+D or from its menu bar icon instead, and sits just below the
menu bar.

Coordinates are points, measured from the top-left of the main screen (Cocoa
measures from the bottom-left, so they're flipped here).
"""

import ctypes
import fcntl
import logging
import os
import plistlib
import subprocess
import sys
import threading
import time
from pathlib import Path

import AppKit
import Quartz
from PyObjCTools import AppHelper

APP_NAME = "Studeck"
LAUNCH_AGENT = Path.home() / "Library" / "LaunchAgents" / "com.studeck.plist"
OLD_LAUNCH_AGENT = LAUNCH_AGENT.with_name("com.studentdashboard.plist")  # before the rename

# Window behaviour: on every Space (desktop), and over full-screen apps.
JOIN_ALL_SPACES, STATIONARY, FULLSCREEN_AUX = 1 << 0, 1 << 4, 1 << 8
# AppleAccentColor -> (accent on dark, accent on light)
ACCENTS = {
    -1: ("#a0a0a5", "#6e6e73"), 0: ("#ff6961", "#d70015"), 1: ("#ffb340", "#c93400"),
    2: ("#ffd426", "#a05a00"), 3: ("#63d46a", "#248a3d"), 4: ("#64a8ff", "#0a5fd6"),
    5: ("#c58af9", "#8944ab"), 6: ("#ff6ea8", "#d30f45"),
}


def _main_height():
    return AppKit.NSScreen.screens()[0].frame().size.height


def _on_main(fn, *args):
    """Run on the main (AppKit) thread and wait for it."""
    if AppKit.NSThread.isMainThread():
        return fn(*args)
    done, box = threading.Event(), {}

    def run():
        try:
            box["value"] = fn(*args)
        except Exception as e:  # pragma: no cover - reported to the caller
            box["error"] = e
        finally:
            done.set()
    AppHelper.callAfter(run)
    done.wait(5)
    if "error" in box:
        raise box["error"]
    return box.get("value")


def _osascript(script, timeout=10):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True, timeout=timeout)


def _as_string(text):
    return '"' + str(text).replace("\\", "\\\\").replace('"', '\\"') + '"'


# ---------------------------------------------------------------- Carbon hotkeys
# RegisterEventHotKey needs no Accessibility permission (unlike watching all keys).
_carbon = None
_HANDLER = ctypes.CFUNCTYPE(ctypes.c_int32, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p)


class _EventTypeSpec(ctypes.Structure):
    _fields_ = [("eventClass", ctypes.c_uint32), ("eventKind", ctypes.c_uint32)]


class _EventHotKeyID(ctypes.Structure):
    _fields_ = [("signature", ctypes.c_uint32), ("id", ctypes.c_uint32)]


def _fourcc(s):
    return int.from_bytes(s.encode("ascii"), "big")


class Desktop:
    name = "mac"
    keys = {"toggle": "⌃⌥D", "quickadd": "⌃⌥A"}
    autostart_label = "Open at login"
    edge_trigger = False    # the top edge is the menu bar
    animate = False         # appears in place (sliding would cross the menu bar)

    def __init__(self, here, data_dir):
        self.here = Path(here)
        self.data_dir = Path(data_dir)
        self.window = None
        self.previous_app = None
        self._lock = None
        self._hotkey_refs = []
        self._handler = None

    # -- the app
    def single_instance(self):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._lock = open(self.data_dir / ".running", "w")
        try:
            fcntl.flock(self._lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    def message_box(self, text):
        _osascript(f"display dialog {_as_string(text)} with title {_as_string(APP_NAME)} buttons {{\"OK\"}} default button 1", 600)

    def background(self, fn):
        return fn

    def gui(self):
        return "cocoa"

    # -- screen and mouse
    def cursor(self):
        p = AppKit.NSEvent.mouseLocation()
        return p.x, _main_height() - p.y

    def _screen_at(self, x, y):
        cy = _main_height() - y
        for screen in AppKit.NSScreen.screens():
            f = screen.frame()
            if f.origin.x <= x < f.origin.x + f.size.width and f.origin.y <= cy < f.origin.y + f.size.height:
                return screen
        return AppKit.NSScreen.mainScreen() or AppKit.NSScreen.screens()[0]

    def panel_area(self, x, y):
        """The screen under the point, below the menu bar (and beside the Dock)."""
        vf = self._screen_at(x, y).visibleFrame()
        h = _main_height()
        return vf.origin.x, h - (vf.origin.y + vf.size.height), vf.origin.x + vf.size.width, h - vf.origin.y

    def scale_at(self, x, y):
        return 1.0  # points already are "logical" pixels

    def mouse_button_down(self):
        return AppKit.NSEvent.pressedMouseButtons() != 0

    def fullscreen_app_running(self):
        return False

    def idle_seconds(self):
        try:
            return float(Quartz.CGEventSourceSecondsSinceLastEventType(
                Quartz.kCGEventSourceStateHIDSystemState, Quartz.kCGAnyInputEventType))
        except Exception:
            return 0.0

    def system_theme(self):
        out = {"dark": False, "accentLight": "#64a8ff", "accentDark": "#0a5fd6"}
        try:
            r = subprocess.run(["defaults", "read", "-g", "AppleInterfaceStyle"], capture_output=True, text=True, timeout=5)
            out["dark"] = r.stdout.strip().lower() == "dark"
            r = subprocess.run(["defaults", "read", "-g", "AppleAccentColor"], capture_output=True, text=True, timeout=5)
            accent = int(r.stdout.strip()) if r.returncode == 0 and r.stdout.strip() else 4
            out["accentLight"], out["accentDark"] = ACCENTS.get(accent, ACCENTS[4])
        except Exception:
            logging.debug("could not read the macOS theme", exc_info=True)
        return out

    # -- open at login: a LaunchAgent
    def autostart_enabled(self):
        return LAUNCH_AGENT.exists()

    def migrate(self):
        """From before the rename: swap the old LaunchAgent for a "com.studeck" one."""
        if OLD_LAUNCH_AGENT.exists():
            subprocess.run(["launchctl", "unload", str(OLD_LAUNCH_AGENT)], capture_output=True)
            OLD_LAUNCH_AGENT.unlink(missing_ok=True)
            self.set_autostart(True)

    def set_autostart(self, enabled):
        if not enabled:
            subprocess.run(["launchctl", "unload", str(LAUNCH_AGENT)], capture_output=True)
            LAUNCH_AGENT.unlink(missing_ok=True)
            return
        if getattr(sys, "frozen", False):  # the packaged Studeck.app
            program, folder = [sys.executable, "--startup"], Path(sys.executable).parent
        else:
            program, folder = [sys.executable, str(self.here / "dashboard.py"), "--startup"], self.here
        LAUNCH_AGENT.parent.mkdir(parents=True, exist_ok=True)
        with open(LAUNCH_AGENT, "wb") as f:
            plistlib.dump({
                "Label": "com.studeck",
                "ProgramArguments": program,
                "WorkingDirectory": str(folder),
                "RunAtLoad": True,
                "ProcessType": "Interactive",
            }, f)
        subprocess.run(["launchctl", "load", str(LAUNCH_AGENT)], capture_output=True)

    def open_text_file(self, path):
        subprocess.Popen(["open", "-t", str(path)])

    def notify(self, title, message):
        r = _osascript(f"display notification {_as_string(message)} with title {_as_string(title)}")
        return r.returncode == 0

    # -- hotkeys (Ctrl+Option+D, Ctrl+Option+A)
    def run_hotkeys(self, on_key):
        def register():
            global _carbon
            try:
                _carbon = ctypes.cdll.LoadLibrary("/System/Library/Frameworks/Carbon.framework/Carbon")
                _carbon.GetApplicationEventTarget.restype = ctypes.c_void_p
                _carbon.InstallEventHandler.argtypes = [ctypes.c_void_p, _HANDLER, ctypes.c_uint32,
                                                        ctypes.POINTER(_EventTypeSpec), ctypes.c_void_p, ctypes.c_void_p]
                _carbon.RegisterEventHotKey.argtypes = [ctypes.c_uint32, ctypes.c_uint32, _EventHotKeyID,
                                                        ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
                _carbon.GetEventParameter.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p,
                                                      ctypes.c_size_t, ctypes.c_void_p, ctypes.c_void_p]
                names = {1: "toggle", 2: "quickadd"}

                def handler(_call, event, _data):
                    hk = _EventHotKeyID()
                    _carbon.GetEventParameter(event, _fourcc("----"), _fourcc("hkid"), None,
                                              ctypes.sizeof(hk), None, ctypes.byref(hk))
                    if hk.id in names:
                        on_key(names[hk.id])
                    return 0

                self._handler = _HANDLER(handler)  # keep a reference
                spec = _EventTypeSpec(_fourcc("keyb"), 5)  # kEventClassKeyboard, kEventHotKeyPressed
                target = _carbon.GetApplicationEventTarget()
                _carbon.InstallEventHandler(target, self._handler, 1, ctypes.byref(spec), None, None)
                control_option = 0x1000 | 0x0800  # controlKey | optionKey
                for hk_id, keycode in ((1, 2), (2, 0)):  # kVK_ANSI_D, kVK_ANSI_A
                    ref = ctypes.c_void_p()
                    status = _carbon.RegisterEventHotKey(keycode, control_option, _EventHotKeyID(_fourcc("Stdk"), hk_id),
                                                         target, 0, ctypes.byref(ref))
                    if status != 0:
                        logging.warning("hotkey %s is taken (%s)", names[hk_id], status)
                    self._hotkey_refs.append(ref)
            except Exception:
                logging.exception("could not register the hotkeys - use the menu bar icon")
        AppHelper.callAfter(register)

    def stop_hotkeys(self):
        pass

    def run_tray(self, icon, on_ready):
        def start():
            try:
                icon.run_detached()
                icon.visible = True
            except Exception:
                logging.exception("could not add the menu bar icon")
            on_ready()
        AppHelper.callAfter(start)

    # -- the panel window
    def attach_panel(self, window, width, height):
        self.window = window

        def setup():
            AppKit.NSApplication.sharedApplication().setActivationPolicy_(1)  # accessory: no Dock icon
            w = window.native
            w.setLevel_(AppKit.NSStatusWindowLevel)
            w.setCollectionBehavior_(JOIN_ALL_SPACES | STATIONARY | FULLSCREEN_AUX)
            w.setHasShadow_(True)
            w.orderOut_(None)
        _on_main(setup)

    def place_panel(self, x, y, width, height):
        h = _main_height()

        def place():
            w = self.window.native
            w.setFrame_display_(AppKit.NSMakeRect(x, h - y - height, width, height), True)
            w.orderFrontRegardless()
        _on_main(place)

    def show_panel(self):
        _on_main(lambda: self.window.native.orderFrontRegardless())

    def move_panel(self, x, y):
        h = _main_height()
        _on_main(lambda: self.window.native.setFrameTopLeftPoint_(AppKit.NSMakePoint(x, h - y)))

    def park_panel(self, height):
        _on_main(lambda: self.window.native.orderOut_(None))

    def remember_foreground(self):
        self.previous_app = AppKit.NSWorkspace.sharedWorkspace().frontmostApplication()

    def restore_foreground(self):
        app = self.previous_app
        if app is not None and AppKit.NSApplication.sharedApplication().isActive():
            try:
                app.activateWithOptions_(0)
            except Exception:
                pass

    def foreground_is_ours(self):
        return bool(AppKit.NSApplication.sharedApplication().isActive())

    def activate_panel(self, window):
        def activate():
            AppKit.NSApplication.sharedApplication().activateIgnoringOtherApps_(True)
            window.native.makeKeyAndOrderFront_(None)
        _on_main(activate)

    def release_startup_focus(self, stopping, is_visible):
        pass

    def pick_ics(self, window, panel_rect):
        import webview
        paths = window.create_file_dialog(
            webview.OPEN_DIALOG, directory=str(Path.home() / "Downloads"), allow_multiple=False,
            file_types=("Calendar files (*.ics;*.ical;*.icalendar;*.ifb)", "All files (*.*)"))
        return {"path": str(paths[0])} if paths else {"cancelled": True}

    # -- the floating focus timer
    def attach_mini(self, win, width, height):
        handle = {"win": win, "w": width, "h": height}

        def setup():
            w = win.native
            w.setLevel_(AppKit.NSStatusWindowLevel)
            w.setCollectionBehavior_(JOIN_ALL_SPACES | STATIONARY | FULLSCREEN_AUX)
            w.setContentSize_(AppKit.NSMakeSize(width, height))
        _on_main(setup)
        x, y = self.mini_spot(handle)
        self.move_mini(handle, x, y)
        return handle

    def mini_spot(self, handle):
        """Bottom-right of the main screen, above the Dock."""
        left, top, right, bottom = self.panel_area(1, 1)
        margin = 10
        return right - handle["w"] - margin, bottom - handle["h"] - margin

    def move_mini(self, handle, x, y):
        h = _main_height()
        _on_main(lambda: handle["win"].native.setFrameTopLeftPoint_(AppKit.NSMakePoint(x, h - y)))

    def show_mini(self, handle, show):
        w = handle["win"].native
        _on_main(lambda: w.orderFrontRegardless() if show else w.orderOut_(None))
