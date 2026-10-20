"""
Studeck - a panel at the top of the screen with your timetable, deadlines,
coursework, plans, music and a focus timer.

Windows: rest the mouse on the top edge, or press Ctrl+Alt+D.
Mac (beta): press Ctrl+Option+D, or click the menu bar icon.

Start:  Windows - double-click "Start Studeck.bat"
        Mac     - double-click "Start Studeck.command"
Quit:   the tray / menu bar icon -> Quit
Setup:  the first time it runs, a setup window walks you through everything;
        reopen it any time from the icon -> Settings.

The platform-specific parts are in desktop_win.py and desktop_mac.py.
"""

import base64
import datetime as dt
import hashlib
import json
import logging
import os
import queue
import re
import shutil
import sys
import threading
import time
import webbrowser
from pathlib import Path

import calendars
import media
import reminders

HERE = Path(__file__).resolve().parent
IS_MAC = sys.platform == "darwin"

# Private and device-only files (calendar links, calendar cache, log, reminder
# records) live in a local folder that cloud sync doesn't touch. Your own data
# (state.json, my-data.js) stays next to the app (both are in .gitignore).
DATA_DIR = Path(os.environ.get("USERPROFILE") or Path.home()) / ".studeck"
_OLD_DATA_DIR = DATA_DIR.with_name(".student-dashboard")  # before the app was called Studeck
if _OLD_DATA_DIR.is_dir() and not DATA_DIR.exists():
    try:
        _OLD_DATA_DIR.rename(DATA_DIR)
    except OSError:
        DATA_DIR = _OLD_DATA_DIR  # in use: keep using it
DATA_DIR.mkdir(parents=True, exist_ok=True)
PRIVATE_FILES = ["calendar-links.txt", "feeds-cache.json", "reminders.json", "summary.json", "dashboard.log"]
for _name in PRIVATE_FILES:  # move them out of the app folder (once, from older versions)
    _src, _dst = HERE / _name, DATA_DIR / _name
    if _src.exists() and not _dst.exists():
        try:
            shutil.move(str(_src), str(_dst))
        except OSError:
            pass

logging.basicConfig(
    filename=DATA_DIR / "dashboard.log",
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

if IS_MAC:
    import desktop_mac as _desktop_module
else:
    import desktop_win as _desktop_module
desktop = _desktop_module.Desktop(HERE, DATA_DIR)

# ---------------------------------------------------------------- settings
# Panel height: this share of the screen, but never smaller than MIN_PANEL or
# bigger than MAX_PANEL logical pixels (so it works on a small laptop screen and
# a big monitor alike), and never more than MAX_SHARE of the screen.
HEIGHT_RATIO = 0.23
MIN_PANEL, MAX_PANEL, MAX_SHARE = 205, 320, 0.45
TRIGGER_PX = 2               # how close to the top edge counts as "at the top" (Windows)
DWELL_SECONDS = 0.30         # rest at the top this long before it opens
HIDE_DELAY_SECONDS = 0.40    # grace period after the mouse leaves the panel
ANIMATION_SECONDS = 0.18     # slide duration
REVIEW_HOUR = 18             # the weekly review pops up on Sunday from 6pm
MINI_SIZE = (216, 40)        # the floating focus timer (logical pixels)
TOAST_SIZE = (360, 96)       # notifications (logical pixels)
TOAST_SECONDS = 8            # how long a notification stays (longer while the mouse is on it)
# How often the mouse is checked: often near the top edge or while the panel is
# open, rarely elsewhere - so the dashboard costs almost nothing while you work.
FAST_POLL = 0.03             # seconds
SLOW_POLL = 0.06             # mouse moving, far from the top edge
IDLE_POLL = 0.15             # mouse still for 2s, far from the top edge
NEAR_TOP_PX = 200

APP_NAME = "Studeck"
ICONS = HERE / "icons"
STATE_FILE = HERE / "state.json"
# data.js is the sample shipped with the app; my-data.js (your copy, kept out
# of git) replaces it once it exists. Most people never need it: the setup
# window covers names, modules, semesters and preferences.
SAMPLE_DATA_FILE = HERE / "data.js"
USER_DATA_FILE = HERE / "my-data.js"
WATCHED_FILES = ["my-data.js", "data.js", "app.js", "styles.css", "index.html"]


def panel_height(area_height, scale):
    logical = area_height / scale
    h = min(max(logical * HEIGHT_RATIO, MIN_PANEL), MAX_PANEL, logical * MAX_SHARE)
    return max(1, round(h * scale))


def window_size(width, height):
    """A window size that fits the screen it opens on (logical pixels)."""
    try:
        import webview
        screen = webview.screens[0]
        width = min(width, int(screen.width * 0.92))
        height = min(height, int(screen.height * 0.88))
    except Exception:
        pass
    return width, height


# ---------------------------------------------------------------- saved state
def replace_file(tmp, dst, attempts=6):
    """os.replace, retried briefly: OneDrive can hold a file open while it syncs."""
    for i in range(attempts):
        try:
            os.replace(tmp, dst)
            return
        except PermissionError:
            if i == attempts - 1:
                raise
            time.sleep(0.25 * (i + 1))


_state_lock = threading.Lock()


def read_state():
    try:
        with open(STATE_FILE, encoding="utf-8-sig") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        logging.exception("Could not read %s", STATE_FILE)
        # Keep the unreadable file (rather than overwriting it on the next save).
        try:
            os.replace(STATE_FILE, STATE_FILE.with_name("state.json.unreadable"))
        except OSError:
            pass
        return {}


def write_state(data):
    tmp = STATE_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    replace_file(tmp, STATE_FILE)


def setup_done():
    """Has this person been through first-time setup (or set things up by hand)?"""
    if (read_state().get("settings") or {}).get("setupDone"):
        return True
    try:  # an existing my-data.js with real data counts as set up
        text = USER_DATA_FILE.read_text(encoding="utf-8")
        return bool(re.search(r"sample\s*:\s*false", text))
    except OSError:
        return False


# ---------------------------------------------------------------- daily summary
SUMMARY_FILE = DATA_DIR / "summary.json"
DAY_STARTS_AT = 4  # a new day starts at 4am, so working past midnight doesn't count


def summary_day():
    return (dt.datetime.now() - dt.timedelta(hours=DAY_STARTS_AT)).date().isoformat()


def read_summary_state():
    try:
        with open(SUMMARY_FILE, encoding="utf-8-sig") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        logging.exception("could not read %s", SUMMARY_FILE)
        return {}


def write_summary_state(data):
    tmp = SUMMARY_FILE.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    replace_file(tmp, SUMMARY_FILE)


def summary_enabled():
    return read_summary_state().get("enabled", True) is not False


def set_summary_enabled(on):
    write_summary_state(dict(read_summary_state(), enabled=bool(on)))


def review_enabled():
    return read_summary_state().get("review", True) is not False


def set_review_enabled(on):
    write_summary_state(dict(read_summary_state(), review=bool(on)))


def _safe_js(win, code):
    try:
        win.evaluate_js(code)
    except Exception:
        logging.debug("evaluate_js failed", exc_info=True)


# ---------------------------------------------------------------- dashboard
class Dashboard:
    def __init__(self):
        self.window = None
        self.visible = False
        self.rect = (0, 0, 0, 0)  # left, top, width, height while shown
        self.requests = queue.Queue()  # "toggle" / "show" / "hide" / "quickadd" from other threads
        self.stopping = threading.Event()
        self.tray = None
        self.tray_ready = threading.Event()
        self.notify_lock = threading.Lock()
        self.hold = False  # set by the page while a form is open, so the panel doesn't slide away
        # Deadlines + uni timetable (cached copy is available straight away).
        self.feeds = calendars.Feeds(str(DATA_DIR), on_update=self.on_feeds_updated)
        # Deadline reminders (the page sends the coursework list, then reminders_ready is set).
        self.reminders = reminders.Reminders(str(DATA_DIR), notify=self.notify)
        self.reminders_ready = threading.Event()
        # Now playing and the focus timer.
        self.media = media.Media(str(DATA_DIR), on_update=self.on_media_updated, notify=self.notify)
        # The daily "Today at a glance" pop-up (and the Sunday weekly review).
        self.summary_window = None
        self.summary_lock = threading.Lock()
        # The setup / settings window.
        self.settings_window = None
        self.settings_lock = threading.Lock()
        # The floating focus timer, shown while a focus session or break runs.
        self.mini_window = None
        self.mini_handle = None
        self.mini_shown = False
        self.mini_lock = threading.Lock()
        # Notifications: Studeck's own pop-up in the corner, one at a time.
        self.toasts = queue.Queue()
        self.toast_window = None
        self.toast_handle = None
        self.toast_ready = threading.Event()
        self.toast_done = threading.Event()
        self.toast_thread = None

    # -- javascript bridge
    def js(self, code):
        def run():
            try:
                self.window.evaluate_js(code)
            except Exception:
                logging.debug("evaluate_js failed", exc_info=True)
        threading.Thread(target=run, daemon=True).start()

    def js_all(self, code):
        """Run in every open window (panel, pop-up, settings)."""
        self.js(code)
        for win in (self.summary_window, self.settings_window):
            if win is not None:
                threading.Thread(target=lambda w=win: _safe_js(w, code), daemon=True).start()

    # -- showing and hiding (called from the mouse thread)
    def _slide(self, y0, y1):
        left = self.rect[0]
        start = time.perf_counter()
        while True:
            p = min(1.0, (time.perf_counter() - start) / ANIMATION_SECONDS)
            eased = 1 - (1 - p) ** 3
            desktop.move_panel(left, round(y0 + (y1 - y0) * eased))
            if p >= 1.0:
                return
            time.sleep(1 / 120)

    def show(self, area):
        left, top, right, bottom = area
        scale = desktop.scale_at(left + 1, top + 1)
        width, height = right - left, panel_height(bottom - top, scale)
        self.rect = (left, top, width, height)
        desktop.remember_foreground()
        self.visible = True
        self.media.set_active(True)
        self.js("window.onDashShown && window.onDashShown()")
        if desktop.animate:
            desktop.place_panel(left, top - height, width, height)
            self._slide(top - height, top)
        else:
            desktop.place_panel(left, top, width, height)

    def hide(self):
        if not self.visible:
            return
        _, top, _, height = self.rect
        if desktop.animate:
            self._slide(top, top - height)
        desktop.park_panel(height)
        self.visible = False
        self.hold = False
        desktop.restore_foreground()
        self.js("window.onDashHidden && window.onDashHidden()")
        self.media.set_active(False)

    def mouse_loop(self):
        dwell_start = None
        leave_start = None
        entered = False   # has the mouse been inside the panel since it opened?
        pinned = False    # opened by hotkey/tray: stays until the mouse visits and leaves
        pending = []      # a request that arrived while waiting
        last_pt, still_since = None, time.monotonic()
        delay = FAST_POLL
        while not self.stopping.is_set():
            slept, delay = delay, FAST_POLL
            try:
                while True:
                    if pending:
                        req = pending.pop()
                    else:
                        try:
                            req = self.requests.get_nowait()
                        except queue.Empty:
                            break
                    if req == "hide" or (req == "toggle" and self.visible):
                        self.hide()
                    elif req in ("toggle", "show") and not self.visible:
                        self.show(desktop.panel_area(*desktop.cursor()))
                        pinned, entered, leave_start = True, False, None
                    elif req == "quickadd":
                        if not self.visible:
                            self.show(desktop.panel_area(*desktop.cursor()))
                            pinned, entered, leave_start = True, False, None
                        desktop.activate_panel(self.window)
                        self.js("window.openQuickAdd && window.openQuickAdd()")

                x, y = desktop.cursor()
                now = time.monotonic()
                if last_pt is None or (x, y) != last_pt:
                    last_pt, still_since = (x, y), now
                if not self.visible and not desktop.edge_trigger:
                    delay = 1.0  # Mac: only the hotkey / menu bar icon open it (they wake this at once)
                elif not self.visible:
                    area = desktop.panel_area(x, y)
                    at_top = y < area[1] + TRIGGER_PX and area[0] <= x < area[2]
                    # Far from the top edge there's no hurry: check less often
                    # (and even less while the mouse isn't moving).
                    if y > area[1] + NEAR_TOP_PX:
                        delay = IDLE_POLL if now - still_since > 2 else SLOW_POLL
                    if at_top and not desktop.mouse_button_down() and not desktop.fullscreen_app_running():
                        if dwell_start is None:
                            # It got there some time during the last (maybe longer) sleep.
                            dwell_start = now - slept / 2
                        elif now - dwell_start >= DWELL_SECONDS:
                            self.show(area)
                            dwell_start, leave_start = None, None
                            pinned, entered = False, True
                    else:
                        dwell_start = None
                else:
                    left, top, width, height = self.rect
                    inside = left <= x < left + width and top <= y < top + height
                    # While you're typing in a form the panel stays put - but only while
                    # it (or its file picker) has focus, so clicking into another app
                    # still lets it slide away.
                    held = self.hold and desktop.foreground_is_ours()
                    if inside or held:
                        entered, leave_start = entered or inside, None
                    elif pinned and not entered:
                        pass
                    elif leave_start is None:
                        leave_start = now
                    elif now - leave_start >= HIDE_DELAY_SECONDS:
                        self.hide()
                        leave_start = None
            except Exception:
                logging.exception("mouse loop error")
                time.sleep(1)
            # Sleep until the next check - but wake at once for the hotkey/tray.
            try:
                pending.append(self.requests.get(timeout=delay))
            except queue.Empty:
                pass

    def watch_loop(self):
        def mtimes():
            out = {}
            for name in WATCHED_FILES:
                try:
                    out[name] = (HERE / name).stat().st_mtime
                except OSError:
                    out[name] = None
            return out

        last = mtimes()
        while not self.stopping.wait(2.0):
            current = mtimes()
            if current != last:
                last = current
                time.sleep(0.2)  # let the editor finish writing
                logging.info("files changed - reloading")
                self.js("location.reload()")

    # -- tray / menu bar icon
    def start_tray(self):
        try:
            import pystray
            from PIL import Image, ImageDraw
        except ImportError:
            logging.warning("pystray/Pillow missing - no tray icon")
            return

        try:
            img = Image.open(ICONS / "tray.png")
        except OSError:  # icons folder missing: a plain stand-in
            img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
            ImageDraw.Draw(img).rounded_rectangle((2, 2, 62, 62), radius=14, fill=(100, 126, 250, 255))

        def open_data(icon, item):
            # First time: start your own copy from the sample.
            if not USER_DATA_FILE.exists():
                try:
                    shutil.copyfile(SAMPLE_DATA_FILE, USER_DATA_FILE)
                except OSError:
                    logging.exception("could not create %s", USER_DATA_FILE)
                    return
            desktop.open_text_file(USER_DATA_FILE)

        def toggle_autostart(icon, item):
            try:
                desktop.set_autostart(not desktop.autostart_enabled())
            except OSError:
                logging.exception("could not change autostart")

        menu = pystray.Menu(
            pystray.MenuItem(f"Show dashboard   {desktop.keys['toggle']}", lambda icon, item: self.requests.put("show"), default=True),
            pystray.MenuItem("Settings…", lambda icon, item: self.show_settings()),
            pystray.MenuItem("Refresh calendars now", lambda icon, item: self.feeds.trigger()),
            pystray.MenuItem("Today at a glance", lambda icon, item: self.show_summary()),
            pystray.MenuItem("Weekly review", lambda icon, item: self.show_summary(review=True)),
            pystray.MenuItem("Deadline reminders", lambda icon, item: self.reminders.set_enabled(not self.reminders.enabled),
                             checked=lambda item: self.reminders.enabled),
            pystray.MenuItem("Daily summary pop-up", lambda icon, item: set_summary_enabled(not summary_enabled()),
                             checked=lambda item: summary_enabled()),
            pystray.MenuItem("Weekly review pop-up (Sundays)", lambda icon, item: set_review_enabled(not review_enabled()),
                             checked=lambda item: review_enabled()),
            pystray.MenuItem(desktop.autostart_label, toggle_autostart, checked=lambda item: desktop.autostart_enabled()),
            pystray.MenuItem("Edit my data file (advanced)", open_data),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem("Quit", lambda icon, item: self.quit()),
        )
        self.tray = pystray.Icon("Studeck", img, APP_NAME, menu)
        desktop.run_tray(self.tray, self.tray_ready.set)

    # -- updates pushed to the page
    def on_feeds_updated(self):
        self.js_all("window.onFeedsUpdated && window.onFeedsUpdated()")

    def on_media_updated(self, snapshot):
        self.js(f"window.onMediaUpdated && window.onMediaUpdated({json.dumps(snapshot)})")
        self.update_mini(snapshot.get("focus") or {})

    def on_settings_changed(self):
        self.js_all("window.onSettingsChanged && window.onSettingsChanged()")

    # -- floating focus timer: a small pill in the bottom-right corner
    def update_mini(self, focus):
        want = bool(focus.get("phase")) and focus.get("mini") is not False
        state = {k: focus.get(k) for k in ("phase", "endsAt", "length")}
        state["subject"] = (focus.get("subject") or {}).get("title", "")
        with self.mini_lock:
            win = self.mini_window
            if want and win is None:
                self._open_mini()
                return
            if not want and win is not None:
                self.mini_window = None
                self.mini_handle = None
        if not want and win is not None:
            try:
                win.destroy()
            except Exception:
                logging.debug("could not close the mini timer", exc_info=True)
        elif win is not None:
            code = f"window.onMini && window.onMini({json.dumps(state)})"
            threading.Thread(target=lambda: _safe_js(win, code), daemon=True).start()

    def _open_mini(self):
        import webview
        win = webview.create_window(
            "Focus timer",
            url=(HERE / "mini.html").as_uri(),
            js_api=Api(),
            width=MINI_SIZE[0], height=MINI_SIZE[1], x=-20000, y=-20000, min_size=(60, 20),
            frameless=True, easy_drag=False, shadow=False, resizable=False,
            on_top=True, focus=False, background_color="#202020", zoomable=False,
        )
        win.events.closed += lambda *a: self._mini_closed(win)
        win.events.shown += lambda *a: threading.Thread(target=self._place_mini, args=(win,), daemon=True).start()
        self.mini_window = win

    def _mini_closed(self, win):
        with self.mini_lock:
            if self.mini_window is win:
                self.mini_window = None
                self.mini_handle = None
                self.mini_shown = False

    def _place_mini(self, win):
        """In the bottom-right corner, clear of the taskbar / Dock; hidden while
        the panel is open or a full-screen app is running."""
        try:
            handle = desktop.attach_mini(win, *MINI_SIZE)
            with self.mini_lock:
                if self.mini_window is not win:
                    return
                self.mini_handle = handle
        except Exception:
            logging.exception("could not place the mini timer")
            return
        x, y = desktop.mini_spot(handle)
        shown, checked = None, 0.0
        while not self.stopping.is_set():
            with self.mini_lock:
                if self.mini_handle is not handle:
                    return
            if time.monotonic() - checked > 0.5:
                checked = time.monotonic()
                want = not self.visible and not desktop.fullscreen_app_running()
                if want != shown:
                    desktop.show_mini(handle, want)
                    shown = self.mini_shown = want
            # Keep clear of the taskbar: glide up when an auto-hide taskbar slides
            # in, and back down when it hides again.
            nx, ny = desktop.mini_spot(handle)
            if (nx, ny) != (x, y):
                start, x0, y0 = time.perf_counter(), x, y
                while True:
                    p = min(1.0, (time.perf_counter() - start) / 0.15)
                    e = 1 - (1 - p) ** 3
                    desktop.move_mini(handle, round(x0 + (nx - x0) * e), round(y0 + (ny - y0) * e))
                    if p >= 1.0:
                        break
                    time.sleep(1 / 120)
                x, y = nx, ny
            time.sleep(0.1)

    # -- pop-up windows
    def show_summary(self, review=False):
        """The daily "Today at a glance" pop-up, or (review=True) the weekly review."""
        # (No "?..." on file addresses: pywebview treats it as part of the file name.)
        url = (HERE / ("review.html" if review else "summary.html")).as_uri()
        title = "Your week" if review else "Today at a glance"
        with self.summary_lock:
            if self.summary_window is not None:
                try:
                    self.summary_window.set_title(title)
                    self.summary_window.load_url(url)
                except Exception:
                    logging.exception("could not switch the summary")
                return
            import webview
            width, height = window_size(960, 600)
            win = webview.create_window(
                title,
                url=url,
                js_api=Api(),
                width=width, height=height, min_size=(min(680, width), min(440, height)),
                on_top=True,
                background_color="#202020",
                text_select=True,
                zoomable=False,
            )
            win.events.closed += self._summary_closed
            self.summary_window = win
        logging.info("showing %s", "the weekly review" if review else "today's summary")

    def _summary_closed(self):
        self.summary_window = None

    def close_summary(self):
        win = self.summary_window
        if win is not None:
            try:
                win.destroy()
            except Exception:
                logging.exception("could not close summary")
            self.summary_window = None

    def show_settings(self, first_run=False):
        """The setup window: a guided first-time setup, and the settings later."""
        with self.settings_lock:
            if self.settings_window is not None:
                try:
                    self.settings_window.show()
                except Exception:
                    pass
                return
            import webview
            width, height = window_size(940, 680)
            win = webview.create_window(
                "Set up Studeck" if first_run else "Studeck settings",
                url=(HERE / "settings.html").as_uri(),
                js_api=Api(),
                width=width, height=height, min_size=(min(640, width), min(480, height)),
                background_color="#202020",
                text_select=True,
                zoomable=False,
            )
            win.events.closed += self._settings_closed
            self.settings_window = win
        logging.info("showing settings%s", " (first run)" if first_run else "")

    def _settings_closed(self):
        self.settings_window = None

    def close_settings(self):
        win = self.settings_window
        if win is not None:
            try:
                win.destroy()
            except Exception:
                logging.exception("could not close settings")
            self.settings_window = None

    def summary_loop(self):
        """Open the summary the first time the laptop is used each day: after
        switching on, restarting or waking from sleep, once you're at it."""
        self.stopping.wait(8)  # let log-in / start-up settle and calendars sync
        while not self.stopping.is_set():
            try:
                today = summary_day()
                state = read_summary_state()
                now = dt.datetime.now()
                # Sunday evening: the weekly review instead (once per Sunday).
                review = (review_enabled() and now.weekday() == 6 and now.hour >= REVIEW_HOUR
                          and state.get("last_review") != today)
                daily = summary_enabled() and state.get("last_shown") != today
                if (setup_done() and (review or daily) and desktop.idle_seconds() < 60
                        and not desktop.fullscreen_app_running()):
                    state.update(last_shown=today)
                    if review:
                        state.update(last_review=today)
                    write_summary_state(state)
                    self.show_summary(review=review)
            except Exception:
                logging.exception("summary check failed")
            self.stopping.wait(15)

    def notify(self, title, message, kind=""):
        """A notification: Studeck's own pop-up in the bottom-right corner, in
        the dashboard's colours (see toast.html). kind: deadline / interview /
        focus / break / goal, for its colour and what clicking it opens."""
        self.toasts.put({"title": str(title), "message": str(message), "kind": str(kind or "")})
        with self.notify_lock:
            if self.toast_thread is None:
                self.toast_thread = threading.Thread(target=self._toast_loop, daemon=True)
                self.toast_thread.start()

    def _toast_loop(self):
        while not self.stopping.is_set():
            try:
                note = self.toasts.get(timeout=5)
            except queue.Empty:
                continue
            # Not over a full-screen game, video or slideshow: wait (up to half an hour).
            waited = 0
            while desktop.fullscreen_app_running() and waited < 1800 and not self.stopping.is_set():
                self.stopping.wait(5)
                waited += 5
            try:
                if not self._show_toast(note):
                    self._system_notify(note["title"], note["message"])
            except Exception:
                logging.exception("could not show the notification")
                self._system_notify(note["title"], note["message"])

    def _show_toast(self, note):
        """Show one pop-up and wait until it's gone. False if it couldn't be shown."""
        if self.toast_window is None:
            import webview
            self.toast_ready.clear()
            win = webview.create_window(
                "Studeck notification",
                url=(HERE / "toast.html").as_uri(),
                js_api=Api(),
                width=TOAST_SIZE[0], height=TOAST_SIZE[1], x=-20000, y=-20000, min_size=(60, 20),
                frameless=True, easy_drag=False, shadow=False, resizable=False,
                on_top=True, focus=False, background_color="#202020", zoomable=False,
            )
            win.events.closed += lambda *a: setattr(self, "toast_window", None)
            win.events.loaded += lambda *a: self.toast_ready.set()
            self.toast_window = win
            if not win.events.shown.wait(15):
                return False
            self.toast_handle = desktop.attach_mini(win, *TOAST_SIZE)
        if not self.toast_ready.wait(15) or self.toast_handle is None:
            return False
        win, handle = self.toast_window, self.toast_handle
        self.toast_done.clear()
        _safe_js(win, f"window.showToast && window.showToast({json.dumps(note)})")
        # Bottom-right, above the focus timer when that's showing.
        x, y = desktop.mini_spot(handle)
        if self.mini_shown and self.mini_handle:
            y -= self.mini_handle["h"] + max(8, self.mini_handle["h"] // 4)
        desktop.move_mini(handle, x + handle["w"] // 6, y)
        desktop.show_mini(handle, True)
        start = time.perf_counter()
        while True:  # slide in from the right
            p = min(1.0, (time.perf_counter() - start) / 0.18)
            desktop.move_mini(handle, round(x + handle["w"] // 6 * (1 - p) ** 3), y)
            if p >= 1.0:
                break
            time.sleep(1 / 120)
        self.toast_done.wait(120)  # the page says when it's dismissed (or times out)
        desktop.show_mini(handle, False)
        self.stopping.wait(0.4)
        return True

    def _system_notify(self, title, message):
        """The system's own notification, if Studeck's pop-up can't be shown. On
        Windows it goes through the tray icon, which silently drops
        notifications until it has finished appearing."""
        with self.notify_lock:
            try:
                if desktop.notify(title, message):
                    return
            except Exception:
                logging.debug("desktop notification failed", exc_info=True)
            if self.tray is None or not self.tray_ready.wait(30):
                logging.warning("tray icon not ready - notification not shown: %s", title)
                return
            self.tray.notify(message, title)
            time.sleep(1.5)  # space out several reminders so none get lost

    def quit(self):
        self.stopping.set()
        self.toast_done.set()
        for win in (self.summary_window, self.mini_window, self.settings_window, self.toast_window):  # the app ends once every window has closed
            if win is not None:
                try:
                    win.destroy()
                except Exception:
                    pass
        desktop.stop_hotkeys()
        if self.tray:
            try:
                self.tray.stop()
            except Exception:
                pass
        self.window.destroy()

    # -- startup (runs in a background thread once the GUI is up)
    def setup(self):
        # Wait until pywebview has completely built and shown the window. Touching it
        # earlier races with its construction and can freeze start-up.
        if not self.window.events.shown.wait(60):
            logging.error("window never appeared")
            return
        area = desktop.panel_area(*desktop.cursor())
        self.rect = (area[0], area[1], area[2] - area[0], panel_height(area[3] - area[1], desktop.scale_at(area[0] + 1, area[1] + 1)))
        desktop.attach_panel(self.window, self.rect[2], self.rect[3])

        self.start_tray()
        desktop.run_hotkeys(self.requests.put)
        # The player thread mostly sleeps; it stays at normal priority so its
        # buttons respond at once.
        for target in (self.mouse_loop,
                       lambda: desktop.release_startup_focus(self.stopping, lambda: self.visible),
                       lambda: self.media.run(self.stopping)):
            threading.Thread(target=target, daemon=True).start()
        # Calendar syncing, reminders, the daily pop-up check and the file watcher
        # never need to be quick: run them as low-priority background work so they
        # never compete with your apps.
        for target in (self.watch_loop,
                       self._migrate,
                       lambda: self.feeds.run(self.stopping),
                       lambda: self.reminders.run(self.stopping, self.reminders_ready),
                       self.summary_loop):
            threading.Thread(target=desktop.background(target), daemon=True).start()
        if not setup_done():  # first run: the setup window
            threading.Timer(1.5, lambda: self.show_settings(first_run=True)).start()
        logging.info("dashboard ready (%s)", desktop.name)

    def _migrate(self):
        try:
            desktop.migrate()
        except Exception:
            logging.exception("could not move the start-up setting to the new name")

    def on_loaded(self):
        logging.info("page loaded")
        self.js("window.enterAppMode && window.enterAppMode()")


class Api:
    """Functions the page can call through window.pywebview.api."""

    def get_state(self):
        return read_state()

    def save_state(self, data):
        if not isinstance(data, dict):
            return False
        with _state_lock:
            current = read_state()
            clean = {
                "done": {str(k): bool(v) for k, v in dict(data.get("done") or {}).items()},
                "submitted": {str(k): bool(v) for k, v in dict(data.get("submitted") or {}).items()},
                # Which course you picked for each Learn deadline (Learn's link doesn't say).
                "courseOf": {str(k)[:100]: str(v)[:40] for k, v in dict(data.get("courseOf") or {}).items() if v},
                # Coursework you added on the dashboard.
                "coursework": [cw for cw in (_clean_coursework(x) for x in list(data.get("coursework") or [])[:300]) if cw],
                # Course / weight / progress / link you set for Learn or data.js coursework.
                "cwMeta": {str(k)[:100]: _clean_meta(v) for k, v in dict(data.get("cwMeta") or {}).items() if isinstance(v, dict)},
                # Interviews and other plans (the Life view).
                "plans": [p for p in (_clean_plan(x) for x in list(data.get("plans") or [])[:500]) if p],
                "view": data.get("view") if data.get("view") in ("life", "study") else "uni",
                # Settings belong to the settings window: keep what's saved.
                "settings": current.get("settings") or {},
            }
            write_state(clean)
        return True

    # -- settings (the setup window)
    def get_settings(self):
        return read_state().get("settings") or {}

    def save_settings(self, settings):
        if not isinstance(settings, dict):
            return False
        with _state_lock:
            state = read_state()
            state["settings"] = _clean_settings(settings)
            write_state(state)
        if _dashboard is not None:
            _dashboard.on_settings_changed()
        return True

    def get_platform(self):
        return {
            "name": desktop.name,
            "keys": desktop.keys,
            "autostartLabel": desktop.autostart_label,
            "edgeTrigger": desktop.edge_trigger,
            "hasMyData": USER_DATA_FILE.exists(),
            "welcome": not setup_done(),  # first time: the step-by-step setup
        }

    def get_prefs(self):
        """App-side switches shown in the settings window."""
        out = {"summary": summary_enabled(), "review": review_enabled(), "autostart": False, "reminders": True}
        try:
            out["autostart"] = desktop.autostart_enabled()
        except Exception:
            logging.debug("could not check autostart", exc_info=True)
        if _dashboard is not None:
            out["reminders"] = _dashboard.reminders.enabled
        return out

    def set_pref(self, name, on):
        on = bool(on)
        try:
            if name == "summary":
                set_summary_enabled(on)
            elif name == "review":
                set_review_enabled(on)
            elif name == "autostart":
                desktop.set_autostart(on)
            elif name == "reminders" and _dashboard is not None:
                _dashboard.reminders.set_enabled(on)
            else:
                return False
        except Exception as e:
            logging.exception("could not change %s", name)
            return {"error": str(e)[:200]}
        return True

    def get_links(self):
        """Which calendar links are set (the links themselves stay private)."""
        links = calendars.read_links(str(DATA_DIR / calendars.LINKS_FILE))
        return {k: {"set": bool(v), "host": "a downloaded file" if v.lower().startswith("file:")
                    else re.sub(r"^https?://([^/]+).*$", r"\1", v) if v else ""} for k, v in links.items()}

    def use_ics_file(self, kind):
        """For a uni with no calendar link: pick a downloaded .ics file, keep a
        copy next to the other private files and read the calendar from that."""
        if kind not in calendars.KINDS or _dashboard is None:
            return {"error": "The dashboard isn't ready yet."}
        win = _dashboard.settings_window or _dashboard.window
        try:
            picked = desktop.pick_ics(win, None if win is _dashboard.settings_window else _dashboard.rect)
        except Exception:
            logging.exception("file dialog failed")
            return {"error": "Couldn't open the file picker."}
        if not picked.get("path"):
            return picked
        path = Path(picked["path"])
        try:
            if path.stat().st_size > 30 * 1024 * 1024:
                return {"error": "That file is too big to be a calendar."}
            data = path.read_bytes()
        except OSError:
            return {"error": "Couldn't open that file."}
        if not data.lstrip(b"\xef\xbb\xbf \t\r\n").upper().startswith(b"BEGIN:VCALENDAR"):
            return {"error": f"{path.name} isn't a calendar (.ics) file."}
        dest = DATA_DIR / f"{kind}.ics"
        tmp = dest.with_suffix(".ics.tmp")
        tmp.write_bytes(data)
        calendars.replace_file(str(tmp), str(dest))
        links_path = str(DATA_DIR / calendars.LINKS_FILE)
        links = calendars.read_links(links_path)
        links[kind] = dest.as_uri()
        calendars.write_links(links_path, links)
        _dashboard.feeds.trigger()
        return {"ok": True, "file": path.name}

    def set_links(self, learn=None, timetable=None):
        """Save calendar links (None = leave as is, "" = remove) and sync now."""
        path = str(DATA_DIR / calendars.LINKS_FILE)
        links = calendars.read_links(path)
        for kind, value in (("learn", learn), ("timetable", timetable)):
            if value is None:
                continue
            value = str(value).strip()
            if value.lower().startswith("webcal://"):
                value = "https://" + value[len("webcal://"):]
            if value and not re.match(r"^https?://\S+$", value, re.I):
                return {"error": "Links start with https:// (or webcal://)."}
            links[kind] = value[:2000]
        calendars.write_links(path, links)
        if _dashboard is not None:
            _dashboard.feeds.trigger()
        return True

    def close_settings(self):
        if _dashboard is not None:
            _dashboard.close_settings()

    def open_settings(self):
        if _dashboard is not None:
            _dashboard.requests.put("hide")
            _dashboard.show_settings()

    def open_data_file(self):
        """The advanced my-data.js file, in a text editor."""
        if not USER_DATA_FILE.exists():
            shutil.copyfile(SAMPLE_DATA_FILE, USER_DATA_FILE)
        desktop.open_text_file(USER_DATA_FILE)
        return True

    # -- the panel
    def hide(self):
        if _dashboard is not None:
            _dashboard.requests.put("hide")

    def get_feeds(self):
        return _dashboard.feeds.snapshot() if _dashboard is not None else {}

    def refresh_feeds(self):
        if _dashboard is not None:
            _dashboard.feeds.trigger()
        return True

    def parse_ics(self, text):
        """A module's .ics file (as text) -> its events, for importing coursework."""
        data = str(text or "").encode("utf-8")
        if not data.lstrip(b"\xef\xbb\xbf \t\r\n").upper().startswith(b"BEGIN:VCALENDAR"):
            return {"error": "That isn't a calendar (.ics) file."}
        return _read_ics(data)

    def pick_ics(self):
        """The system Open dialog for a module's .ics file -> {"path"} (read it
        with read_ics_file)."""
        if _dashboard is None or _dashboard.window is None:
            return {"error": "The dashboard isn't ready yet."}
        try:
            return desktop.pick_ics(_dashboard.window, _dashboard.rect)
        except Exception:
            logging.exception("file dialog failed")
            return {"error": "Couldn't open the file picker."}

    def read_ics_file(self, path):
        """A .ics file on this computer -> its events (only calendar files are read)."""
        path = Path(str(path or ""))
        try:
            if path.stat().st_size > 10 * 1024 * 1024:
                return {"error": "That file is too big to be a module calendar (over 10 MB)."}
            data = path.read_bytes()
        except OSError:
            return {"error": "Couldn't open that file."}
        if not data.lstrip(b"\xef\xbb\xbf \t\r\n").upper().startswith(b"BEGIN:VCALENDAR"):
            return {"error": f"{path.name} isn't a calendar (.ics) file."}
        result = _read_ics(data)
        result["file"] = path.name
        return result

    def fetch_ics(self, url):
        """A module's calendar link (https:// or webcal://) -> its events."""
        url = str(url or "").strip()
        if url.lower().startswith("webcal://"):
            url = "https://" + url[len("webcal://"):]
        if not re.match(r"^https?://\S+$", url, re.I):
            return {"error": "That doesn't look like a calendar link."}
        try:
            data = calendars.fetch(url)
        except calendars.FeedError as e:
            return {"error": str(e)}
        return _read_ics(data)

    def close_summary(self):
        if _dashboard is not None:
            _dashboard.close_summary()

    def open_study(self):
        """From the floating timer: show the dashboard on the Study page."""
        if _dashboard is not None:
            _dashboard.requests.put("show")
            _dashboard.js("window.showStudy && window.showStudy()")

    def toast_closed(self):
        """The notification pop-up has gone (timed out, closed, or clicked)."""
        if _dashboard is not None:
            _dashboard.toast_done.set()

    def toast_open(self, kind):
        """A notification was clicked: the dashboard, on the page it's about."""
        if _dashboard is not None:
            view = {"focus": "study", "break": "study", "goal": "study", "interview": "life"}.get(str(kind), "uni")
            _dashboard.requests.put("show")
            _dashboard.js(f"window.showView && window.showView({json.dumps(view)})")
            _dashboard.toast_done.set()

    def get_toast_seconds(self):
        return TOAST_SECONDS

    def test_notification(self):
        """Settings → "Show a test notification"."""
        if _dashboard is not None:
            _dashboard.notify("Coursework due tomorrow at 12:00", "This is how reminders look.\nClick one to open the dashboard.", "deadline")
        return True

    def open_dashboard(self):
        """From a pop-up: close it and show the dashboard."""
        if _dashboard is not None:
            _dashboard.close_summary()
            _dashboard.close_settings()
            _dashboard.requests.put("show")

    def set_reminders(self, items):
        """The page sends upcoming, not-yet-submitted coursework for reminders."""
        if _dashboard is not None:
            _dashboard.reminders.set_items(items)
            _dashboard.reminders_ready.set()

    def get_system_theme(self):
        """The system's light/dark mode and accent colour, for the "auto" theme."""
        return desktop.system_theme()

    def log_error(self, message):
        """Page errors end up in dashboard.log, to help track down problems."""
        logging.warning("page: %s", str(message)[:1000])

    def set_hold(self, on):
        """Keep the panel open (e.g. while you're typing in a form)."""
        if _dashboard is not None:
            _dashboard.hold = bool(on)

    # -- now playing + focus timer
    def get_media(self):
        return _dashboard.media.snapshot() if _dashboard is not None else {}

    def media_command(self, action, value=None):
        """play / pause / toggle / next / previous / seek (value = seconds)."""
        return _dashboard is not None and _dashboard.media.command(str(action), value)

    def get_sound(self, name):
        """One of the ambient recordings in sounds/, as base64 (a page opened
        from a file isn't allowed to fetch other files itself)."""
        if name not in ("rain", "waves", "fire", "cafe"):
            return ""
        try:
            return base64.b64encode((HERE / "sounds" / f"{name}.ogg").read_bytes()).decode("ascii")
        except OSError:
            logging.warning("sound %s is missing", name)
            return ""

    def open_spotify(self):
        """Open the Spotify app, to pick something to play."""
        media.open_spotify()
        if _dashboard is not None:
            _dashboard.requests.put("hide")
        return True

    def focus(self, action, minutes=25, break_minutes=5, pause_for_breaks=True, subject=None, mini=True, goal=0):
        """The focus timer: start / stop / skip. subject = the coursework you're on."""
        if _dashboard is None:
            return False
        if action == "start":
            return _dashboard.media.focus_start(minutes, break_minutes, pause_for_breaks, subject, mini, goal)
        if action == "stop":
            return _dashboard.media.focus_stop()
        if action == "skip":
            return _dashboard.media.focus_skip()
        return False

    def open_url(self, url):
        """Open a link in your normal browser."""
        url = str(url or "").strip()
        if not re.match(r"^https?://[^\s]+$", url, re.I):
            return False
        webbrowser.open(url)
        if _dashboard is not None:
            _dashboard.requests.put("hide")
        return True


def _num(value, lo=0, hi=100):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n:  # NaN
        return None
    n = max(lo, min(hi, n))
    return int(n) if n == int(n) else round(n, 1)


def _clean_link(value):
    link = str(value or "").strip()[:500]
    return link if re.match(r"^https?://[^\s]+$", link, re.I) else ""


def _clean_meta(m):
    out = {}
    if m.get("module"):
        out["module"] = str(m["module"])[:40]
    for key in ("weight", "progress"):
        n = _num(m.get(key))
        if n is not None:
            out[key] = n
    link = _clean_link(m.get("link"))
    if link:
        out["link"] = link
    release = str(m.get("release") or "").strip()
    if re.match(r"^\d{4}-\d{2}-\d{2}$", release):
        out["release"] = release
    return out


DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
COLOR_RE = re.compile(r"^(coral|amber|mint|sky|violet|rose|lime|slate|#[0-9a-fA-F]{6})$")
THEMES = {"auto", "windows-dark", "windows-light", "sage", "sand", "midnight"}
TERM_WORDS = {"Semester", "Term", "Trimester", "Quarter"}
DAYS = {"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _clean_settings(s):
    """Only known settings, of the right types and sizes, get saved."""
    text = lambda v, n: str(v or "").strip()[:n]
    out = {"setupDone": bool(s.get("setupDone"))}
    out["name"] = text(s.get("name"), 60)
    out["theme"] = s.get("theme") if s.get("theme") in THEMES else "auto"
    out["deadlinesName"] = text(s.get("deadlinesName"), 30)
    # Semesters: "auto" (from the timetable) or your own list.
    sem = s.get("semesters") if isinstance(s.get("semesters"), dict) else {}
    terms = []
    for t in list(sem.get("terms") or [])[:6]:
        if not isinstance(t, dict) or not DATE_RE.match(str(t.get("start") or "")):
            continue
        weeks = _num(t.get("weeks"), 1, 30)
        terms.append({
            "name": text(t.get("name"), 40) or "Semester",
            "start": t["start"],
            "weeks": int(weeks or 11),
            "breakWeeks": sorted({int(w) for w in list(t.get("breakWeeks") or [])[:10] if _num(w, 1, 30)}),
        })
    out["semesters"] = {"mode": "manual" if sem.get("mode") == "manual" else "auto", "terms": terms}
    out["termWord"] = s.get("termWord") if s.get("termWord") in TERM_WORDS else "Semester"
    # Weekly classes typed in by hand (for timetables with no calendar link).
    classes = []
    for c in list(s.get("classes") or [])[:80]:
        if not isinstance(c, dict) or c.get("day") not in DAYS or not TIME_RE.match(str(c.get("start") or "")):
            continue
        classes.append({
            "day": c["day"], "start": c["start"],
            "end": c.get("end") if TIME_RE.match(str(c.get("end") or "")) else "",
            "module": text(c.get("module"), 40), "type": text(c.get("type"), 40), "room": text(c.get("room"), 120),
        })
    out["classes"] = classes
    # Modules: how each course shows (short code, colour) and which are hidden.
    mods = []
    for m in list(s.get("modules") or [])[:40]:
        if not isinstance(m, dict) or not text(m.get("name"), 120):
            continue
        mod = {"name": text(m.get("name"), 120), "code": text(m.get("code"), 12),
               "color": m.get("color") if COLOR_RE.match(str(m.get("color") or "")) else "",
               "hidden": bool(m.get("hidden")), "manual": bool(m.get("manual"))}
        match = [text(x, 60) for x in list(m.get("match") or [])[:6] if text(x, 60)]
        if match:
            mod["match"] = match
        mods.append(mod)
    out["modules"] = mods
    study = s.get("study") if isinstance(s.get("study"), dict) else {}
    out["study"] = {
        "focusMinutes": int(_num(study.get("focusMinutes"), 1, 180) or 25),
        "breakMinutes": int(_num(study.get("breakMinutes"), 1, 60) or 5),
        "dailyGoalMinutes": int(_num(study.get("dailyGoalMinutes"), 0, 1440) or 0),
        "miniTimer": study.get("miniTimer") is not False,
    }
    return out


def _read_ics(data):
    try:
        return calendars.parse_ics_events(data, dt.date.today())
    except calendars.FeedError as e:
        return {"error": str(e)}
    except Exception:
        logging.exception("could not read .ics")
        return {"error": "Couldn't read that calendar file."}


PLAN_TYPES = {"interview", "plan", "deadline", "other"}


def _clean_plan(p):
    if not isinstance(p, dict):
        return None
    title = str(p.get("title") or "").strip()[:200]
    date = str(p.get("date") or "").strip()
    if not title or not DATE_RE.match(date):
        return None

    def hhmm(value):
        value = str(value or "").strip()
        return value if re.match(r"^\d{1,2}:\d{2}$", value) else ""

    kind = str(p.get("type") or "plan")
    return {
        "id": str(p.get("id") or "")[:60] or "plan:" + hashlib.sha1(f"{title}|{date}".encode("utf-8")).hexdigest()[:12],
        "type": kind if kind in PLAN_TYPES else "plan",
        "title": title,
        "date": date,
        "start": hhmm(p.get("start")),
        "end": hhmm(p.get("end")),
        "where": str(p.get("where") or "").strip()[:300],
        "notes": str(p.get("notes") or "").strip()[:1000],
    }


def _clean_coursework(c):
    if not isinstance(c, dict):
        return None
    title = str(c.get("title") or "").strip()[:200]
    due = str(c.get("due") or "").strip()
    if not title or not DATE_RE.match(due):
        return None
    time_ = str(c.get("time") or "").strip()
    item = {
        "id": str(c.get("id") or "")[:60] or "my:" + hashlib.sha1(f"{title}|{due}".encode("utf-8")).hexdigest()[:12],
        "title": title,
        "module": str(c.get("module") or "")[:40],
        "due": due,
        "time": time_ if re.match(r"^\d{1,2}:\d{2}$", time_) else "",
    }
    item.update(_clean_meta({k: c.get(k) for k in ("weight", "progress", "link", "release")}))
    return item


_dashboard = None


def main():
    global _dashboard

    if not desktop.single_instance():
        if "--startup" not in sys.argv:  # started at log-in: just quietly stay out of the way
            how = ("rest your mouse on the top edge of the screen, or press " if desktop.edge_trigger
                   else "click its menu bar icon, or press ")
            desktop.message_box(f"Studeck is already running.\n\nTo open it, {how}{desktop.keys['toggle']}.")
        return

    # Load the calendar libraries now, before the window exists, so the background
    # sync never imports them while the window is being built.
    calendars.warm_up()

    import webview

    _dashboard = dash = Dashboard()
    dash.window = webview.create_window(
        APP_NAME,
        url=(HERE / "index.html").as_uri(),
        js_api=Api(),
        width=1200, height=240, x=-20000, y=-20000,
        frameless=True,
        easy_drag=False,
        shadow=False,
        resizable=False,
        on_top=True,
        background_color="#202020",
        text_select=False,
        zoomable=False,
    )
    dash.window.events.loaded += dash.on_loaded
    logging.info("starting on %s", desktop.name)
    icon = ICONS / ("studeck.png" if IS_MAC else "studeck.ico")
    webview.start(dash.setup, gui=desktop.gui(), icon=str(icon) if icon.exists() else None)
    logging.info("stopped")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        logging.exception("fatal error")
        try:
            desktop.message_box(f"Studeck couldn't start:\n\n{exc}\n\nDetails are in "
                                f"{DATA_DIR / 'dashboard.log'}.")
        except Exception:
            pass
