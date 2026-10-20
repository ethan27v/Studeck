"""
Windows side of the dashboard: the window tricks, hotkeys, start-up task,
theme and so on. dashboard.py talks to this through the same small set of
methods as desktop_mac.py, so the rest of the app doesn't care which it is.

Coordinates are physical pixels, measured from the top-left of the main screen.
"""

import ctypes
import ctypes.wintypes as wt
import logging
import os
import subprocess
import sys
import threading
import time
import winreg
from pathlib import Path

APP_NAME = "Studeck"
APP_ID = "Studeck.App"  # groups its windows on the taskbar under its own icon (not Python's)

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
shell32 = ctypes.WinDLL("shell32")


class MONITORINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT), ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]


class LASTINPUTINFO(ctypes.Structure):
    _fields_ = [("cbSize", wt.UINT), ("dwTime", wt.DWORD)]


class THREAD_POWER_THROTTLING_STATE(ctypes.Structure):
    _fields_ = [("Version", wt.ULONG), ("ControlMask", wt.ULONG), ("StateMask", wt.ULONG)]


user32.GetCursorPos.argtypes = [ctypes.POINTER(wt.POINT)]
user32.GetCursorPos.restype = wt.BOOL
user32.MonitorFromPoint.argtypes = [wt.POINT, wt.DWORD]
user32.MonitorFromPoint.restype = wt.HMONITOR
user32.GetMonitorInfoW.argtypes = [wt.HMONITOR, ctypes.POINTER(MONITORINFO)]
user32.GetMonitorInfoW.restype = wt.BOOL
user32.SetWindowPos.argtypes = [wt.HWND, wt.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, wt.UINT]
user32.SetWindowPos.restype = wt.BOOL
user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
user32.ShowWindow.restype = wt.BOOL
user32.GetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int]
user32.GetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.SetWindowLongPtrW.argtypes = [wt.HWND, ctypes.c_int, ctypes.c_ssize_t]
user32.SetWindowLongPtrW.restype = ctypes.c_ssize_t
user32.GetAsyncKeyState.argtypes = [ctypes.c_int]
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.RegisterHotKey.argtypes = [wt.HWND, ctypes.c_int, wt.UINT, wt.UINT]
user32.RegisterHotKey.restype = wt.BOOL
user32.UnregisterHotKey.argtypes = [wt.HWND, ctypes.c_int]
user32.GetMessageW.argtypes = [ctypes.POINTER(wt.MSG), wt.HWND, wt.UINT, wt.UINT]
user32.GetMessageW.restype = wt.BOOL
user32.PostThreadMessageW.argtypes = [wt.DWORD, wt.UINT, wt.WPARAM, wt.LPARAM]
user32.GetForegroundWindow.restype = ctypes.c_void_p
user32.SetForegroundWindow.argtypes = [ctypes.c_void_p]
user32.IsWindow.argtypes = [ctypes.c_void_p]
user32.GetShellWindow.restype = ctypes.c_void_p
user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(wt.DWORD)]
user32.GetWindowThreadProcessId.restype = wt.DWORD
WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)
user32.EnumWindows.argtypes = [WNDENUMPROC, wt.LPARAM]
user32.GetClassNameW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.IsIconic.argtypes = [wt.HWND]
user32.GetWindowRect.argtypes = [wt.HWND, ctypes.POINTER(wt.RECT)]
user32.GetLastInputInfo.argtypes = [ctypes.POINTER(LASTINPUTINFO)]
user32.GetLastInputInfo.restype = wt.BOOL
user32.GetSystemMetrics.argtypes = [ctypes.c_int]
user32.GetSystemMetrics.restype = ctypes.c_int
user32.MessageBoxW.argtypes = [wt.HWND, wt.LPCWSTR, wt.LPCWSTR, wt.UINT]
user32.keybd_event.argtypes = [wt.BYTE, wt.BYTE, wt.DWORD, ctypes.c_size_t]
user32.GetDpiForWindow.argtypes = [wt.HWND]
user32.GetDpiForWindow.restype = wt.UINT
user32.FindWindowW.argtypes = [wt.LPCWSTR, wt.LPCWSTR]
user32.FindWindowW.restype = wt.HWND
shell32.SHQueryUserNotificationState.argtypes = [ctypes.POINTER(ctypes.c_int)]
shell32.SHQueryUserNotificationState.restype = ctypes.c_long
kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, wt.BOOL, wt.LPCWSTR]
kernel32.CreateMutexW.restype = wt.HANDLE
kernel32.GetCurrentThreadId.restype = wt.DWORD
kernel32.GetTickCount.restype = wt.DWORD
kernel32.GetCurrentThread.restype = wt.HANDLE
kernel32.SetThreadPriority.argtypes = [wt.HANDLE, ctypes.c_int]
kernel32.SetThreadInformation.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD]

HWND_TOPMOST = wt.HWND(-1)
SWP_NOSIZE, SWP_NOMOVE, SWP_NOACTIVATE = 0x0001, 0x0002, 0x0010
SW_HIDE, SW_SHOWNOACTIVATE = 0, 4
GWL_EXSTYLE = -20
WS_EX_TOOLWINDOW, WS_EX_APPWINDOW = 0x00000080, 0x00040000
MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY = 2, 1
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
VK_LBUTTON, VK_RBUTTON, VK_MBUTTON = 0x01, 0x02, 0x04
MOD_ALT, MOD_CONTROL, MOD_NOREPEAT = 0x0001, 0x0002, 0x4000
WM_HOTKEY, WM_QUIT = 0x0312, 0x0012
ERROR_ALREADY_EXISTS = 183
FULLSCREEN_STATES = {2, 3, 4}  # SHQueryUserNotificationState: busy, D3D full screen, presentation mode
THREAD_MODE_BACKGROUND_BEGIN = 0x00010000
THREAD_POWER_THROTTLING = 3
NO_WINDOW = 0x08000000  # CREATE_NO_WINDOW: no console flash for helper commands

TASK_NAME = "Studeck"
OLD_TASK_NAME = "Student Dashboard"  # before it was called Studeck
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"  # old start-up method, cleaned up
RUN_VALUE = "StudentDashboard"


def _monitor(pt, flag=MONITOR_DEFAULTTONEAREST):
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    user32.GetMonitorInfoW(user32.MonitorFromPoint(pt, flag), ctypes.byref(info))
    return info


class Desktop:
    name = "windows"
    keys = {"toggle": "Ctrl+Alt+D", "quickadd": "Ctrl+Alt+A"}
    autostart_label = "Start with Windows"
    edge_trigger = True     # rest the mouse on the top edge to open
    animate = True          # slide the panel in and out

    def __init__(self, here, data_dir):
        self.here = Path(here)
        self.data_dir = Path(data_dir)
        self.hwnd = None
        self.previous_foreground = None
        self.startup_foreground = user32.GetForegroundWindow()
        self.hotkey_thread_id = None
        self._mutex = None
        try:
            shell32.SetCurrentProcessExplicitAppUserModelID(APP_ID)
        except Exception:
            logging.debug("could not set the app id", exc_info=True)

    # -- the app
    def single_instance(self):
        self._mutex = kernel32.CreateMutexW(None, False, "Local\\Studeck.SingleInstance")
        return ctypes.get_last_error() != ERROR_ALREADY_EXISTS

    def message_box(self, text):
        user32.MessageBoxW(None, text, APP_NAME, 0x40)  # MB_ICONINFORMATION

    def background(self, fn):
        """Run a thread function as background work: low CPU and disk priority,
        and Windows' power-saving "efficiency mode" (EcoQoS)."""
        def run():
            thread = kernel32.GetCurrentThread()
            try:
                kernel32.SetThreadPriority(thread, THREAD_MODE_BACKGROUND_BEGIN)
                state = THREAD_POWER_THROTTLING_STATE(1, 1, 1)
                kernel32.SetThreadInformation(thread, THREAD_POWER_THROTTLING, ctypes.byref(state), ctypes.sizeof(state))
            except Exception:
                logging.debug("could not lower thread priority", exc_info=True)
            fn()
        return run

    def gui(self):
        return "edgechromium"

    # -- screen and mouse
    def cursor(self):
        pt = wt.POINT()
        user32.GetCursorPos(ctypes.byref(pt))
        return pt.x, pt.y

    def panel_area(self, x, y):
        """(left, top, right, bottom) the panel covers on the screen under the point."""
        r = _monitor(wt.POINT(x, y)).rcMonitor
        return r.left, r.top, r.right, r.bottom

    def scale_at(self, x, y):
        """Physical pixels per logical pixel on the screen under the point."""
        try:
            hmon = user32.MonitorFromPoint(wt.POINT(x, y), MONITOR_DEFAULTTONEAREST)
            dx, dy = ctypes.c_uint(), ctypes.c_uint()
            ctypes.windll.shcore.GetDpiForMonitor(hmon, 0, ctypes.byref(dx), ctypes.byref(dy))
            return (dx.value or 96) / 96
        except Exception:
            return 1.0

    def mouse_button_down(self):
        # Avoids opening while you drag a window to the top edge (Windows snap).
        return any(user32.GetAsyncKeyState(vk) & 0x8000 for vk in (VK_LBUTTON, VK_RBUTTON, VK_MBUTTON))

    def fullscreen_app_running(self):
        # Same check Windows uses to silence notifications during games/videos.
        state = ctypes.c_int(0)
        if shell32.SHQueryUserNotificationState(ctypes.byref(state)) != 0:
            return False
        return state.value in FULLSCREEN_STATES

    def idle_seconds(self):
        """Seconds since the last mouse/keyboard input."""
        info = LASTINPUTINFO()
        info.cbSize = ctypes.sizeof(LASTINPUTINFO)
        if not user32.GetLastInputInfo(ctypes.byref(info)):
            return 0
        return ((kernel32.GetTickCount() - info.dwTime) & 0xFFFFFFFF) / 1000.0

    def system_theme(self):
        """{'dark', 'accentLight', 'accentDark'}: Windows uses a lighter accent on
        dark backgrounds and a darker one on light; both come from the registry."""
        out = {"dark": True, "accentLight": "#4cc2ff", "accentDark": "#0067c0"}
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as key:
                out["dark"] = winreg.QueryValueEx(key, "AppsUseLightTheme")[0] == 0
        except OSError:
            pass
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent") as key:
                palette = bytes(winreg.QueryValueEx(key, "AccentPalette")[0])
            if len(palette) >= 20:
                shade = lambda i: "#%02x%02x%02x" % tuple(palette[i * 4:i * 4 + 3])
                out["accentLight"], out["accentDark"] = shade(1), shade(4)
        except OSError:
            pass
        return out

    # -- start with Windows: a Task Scheduler log-on task. (Windows works through
    # the registry "Run" list one app at a time, about 30 s each, so with several
    # start-up apps the dashboard could take minutes to appear.)
    def _pythonw(self):
        exe = Path(sys.executable)
        pythonw = exe.with_name("pythonw.exe")
        return pythonw if pythonw.exists() else exe

    def _powershell(self, script):
        return subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
                              capture_output=True, text=True, timeout=60, creationflags=NO_WINDOW)

    def _task_exists(self, name):
        result = subprocess.run(["schtasks", "/Query", "/TN", name], capture_output=True, creationflags=NO_WINDOW)
        return result.returncode == 0

    def autostart_enabled(self):
        return self._task_exists(TASK_NAME)

    def migrate(self):
        """From before the rename: swap a "Student Dashboard" start-up task for a "Studeck" one."""
        if self._task_exists(OLD_TASK_NAME):
            self.set_autostart(True)
            self._powershell(f"Unregister-ScheduledTask -TaskName '{OLD_TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue")
            logging.info("start-up task renamed to %s", TASK_NAME)

    def set_autostart(self, enabled):
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
                winreg.DeleteValue(key, RUN_VALUE)
        except OSError:
            pass
        if not enabled:
            self._powershell(f"Unregister-ScheduledTask -TaskName '{TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue")
            return
        q = lambda p: str(p).replace("'", "''")  # PowerShell single-quote escaping
        script = f"""
$me = "$env:USERDOMAIN\\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute '{q(self._pythonw())}' -Argument '"{q(self.here / "dashboard.py")}" --startup' -WorkingDirectory '{q(self.here)}'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$trigger.Delay = 'PT5S'
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '{TASK_NAME}' -Description 'Starts Studeck when you log in.' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force -ErrorAction Stop | Out-Null
"""
        result = self._powershell(script)
        if result.returncode != 0:
            raise OSError(result.stderr.strip() or "could not create the start-up task")

    def open_text_file(self, path):
        # Notepad on purpose: double-clicking a .js file runs it with Windows Script Host.
        subprocess.Popen(["notepad.exe", str(path)])

    def notify(self, title, message):
        return False  # shown through the tray icon instead

    # -- hotkeys (Ctrl+Alt+D, Ctrl+Alt+A)
    def run_hotkeys(self, on_key):
        def loop():
            self.hotkey_thread_id = kernel32.GetCurrentThreadId()
            keys = {1: (self.keys["toggle"], 0x44, "toggle"), 2: (self.keys["quickadd"], 0x41, "quickadd")}
            for hotkey_id, (label, vk, _) in keys.items():
                if not user32.RegisterHotKey(None, hotkey_id, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, vk):
                    logging.warning("%s is taken by another app - that hotkey is off", label)
            msg = wt.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                if msg.message == WM_HOTKEY and msg.wParam in keys:
                    on_key(keys[msg.wParam][2])
            for hotkey_id in keys:
                user32.UnregisterHotKey(None, hotkey_id)
        threading.Thread(target=loop, daemon=True).start()

    def stop_hotkeys(self):
        if self.hotkey_thread_id:
            user32.PostThreadMessageW(self.hotkey_thread_id, WM_QUIT, 0, 0)

    def run_tray(self, icon, on_ready):
        def setup(icon_):
            icon_.visible = True
            on_ready()
        threading.Thread(target=icon.run, kwargs={"setup": setup}, daemon=True).start()

    # -- the panel window
    def attach_panel(self, window, width, height):
        """Once pywebview has shown the window: keep it out of the taskbar and
        Alt+Tab, and park it above the screen."""
        self.hwnd = wt.HWND(window.native.Handle.ToInt64())
        # The style applies after a hide/show. ShowWindow (not SetWindowPos) must do
        # the re-show: WinForms only hears about visibility through WM_SHOWWINDOW,
        # and keeps the browser hidden otherwise.
        ex = user32.GetWindowLongPtrW(self.hwnd, GWL_EXSTYLE)
        user32.SetWindowLongPtrW(self.hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW)
        user32.ShowWindow(self.hwnd, SW_HIDE)
        user32.SetWindowPos(self.hwnd, HWND_TOPMOST, 0, 0, width, height, SWP_NOACTIVATE)
        self.park_panel(height)
        user32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)

    def place_panel(self, x, y, width, height):
        if user32.IsIconic(self.hwnd):  # minimised (e.g. by "Show desktop"): bring it back
            user32.ShowWindow(self.hwnd, SW_SHOWNOACTIVATE)
        user32.SetWindowPos(self.hwnd, HWND_TOPMOST, x, y, width, height, SWP_NOACTIVATE)

    def show_panel(self):
        pass  # never truly hidden (see park_panel)

    def move_panel(self, x, y):
        user32.SetWindowPos(self.hwnd, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)

    def park_panel(self, height):
        # "Hidden" = parked above the whole desktop. The window is never truly
        # hidden because WebView2 stops painting in hidden windows.
        x = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
        y = user32.GetSystemMetrics(SM_YVIRTUALSCREEN) - max(height, 1) - 200
        user32.SetWindowPos(self.hwnd, HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)

    def remember_foreground(self):
        self.previous_foreground = user32.GetForegroundWindow()

    def restore_foreground(self):
        # Clicking the panel gives it keyboard focus; hand focus back so typing
        # doesn't go to the parked (invisible) window.
        prev = self.previous_foreground
        if user32.GetForegroundWindow() == self.hwnd.value and prev and prev != self.hwnd.value and user32.IsWindow(prev):
            user32.SetForegroundWindow(prev)

    def foreground_is_ours(self):
        """Is the active window one of ours (the panel, or a file picker it opened)?"""
        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return False
        pid = wt.DWORD(0)
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        return pid.value == os.getpid()

    def activate_panel(self, window):
        """Give the panel the keyboard (for typing in quick add)."""
        if not user32.SetForegroundWindow(self.hwnd):
            # Windows only lets the app you're using hand over the keyboard;
            # a tap of Alt counts as using it.
            user32.keybd_event(0x12, 0, 0, 0)
            user32.keybd_event(0x12, 0, 2, 0)  # KEYEVENTF_KEYUP
            user32.SetForegroundWindow(self.hwnd)
        try:
            from System import Action
            window.native.BeginInvoke(Action(lambda: window.native.browser.webview.Focus()))
        except Exception:
            logging.debug("could not focus the page", exc_info=True)

    def release_startup_focus(self, stopping, is_visible):
        # The window gets activated when it's created; give focus back to whatever
        # you were using (or the desktop) so typing doesn't go to the parked panel.
        end = time.monotonic() + 4
        while time.monotonic() < end and not stopping.is_set():
            if not is_visible() and user32.GetForegroundWindow() == self.hwnd.value:
                target = self.startup_foreground
                if not (target and target != self.hwnd.value and user32.IsWindow(target)):
                    target = user32.GetShellWindow()
                user32.SetForegroundWindow(target)
            time.sleep(0.1)

    def pick_ics(self, window, panel_rect):
        """Windows' Open dialog for a module's .ics file. (The page's own file
        picker doesn't open in this frameless, always-on-top window, so it comes
        from here - on the window's own thread, where it opens and closes promptly.)"""
        result = {}

        def show():
            import System.Windows.Forms as WinForms
            dialog = WinForms.OpenFileDialog()
            dialog.Title = "Import a module calendar (.ics)"
            dialog.Filter = ("Calendar files (*.ics;*.ical;*.icalendar;*.ifb)|*.ics;*.ical;*.icalendar;*.ifb"
                             "|All files (*.*)|*.*")
            downloads = Path.home() / "Downloads"
            if downloads.is_dir():
                dialog.InitialDirectory = str(downloads)
            dialog.RestoreDirectory = True
            if dialog.ShowDialog(window.native) == WinForms.DialogResult.OK:
                result["path"] = str(dialog.FileName)

        from System import Action
        if panel_rect:  # from the panel (not the Settings window, where it opens in the right place)
            self._place_dialog_soon(panel_rect)
        window.native.Invoke(Action(show))
        return result if result.get("path") else {"cancelled": True}

    def _place_dialog_soon(self, panel_rect):
        """Windows opens file dialogs in the corner, under the always-on-top
        panel. Wait for ours to appear, then centre it below the panel, on top."""
        def run():
            pid = os.getpid()
            for _ in range(100):  # up to 10 s
                time.sleep(0.1)
                found = []

                def check(hwnd, _):
                    owner = wt.DWORD(0)
                    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
                    if owner.value == pid and user32.IsWindowVisible(hwnd):
                        cls = ctypes.create_unicode_buffer(64)
                        user32.GetClassNameW(hwnd, cls, 64)
                        if cls.value == "#32770":  # standard dialog
                            found.append(hwnd)
                    return True
                user32.EnumWindows(WNDENUMPROC(check), 0)
                if not found:
                    continue
                hwnd = found[0]
                r = wt.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(r))
                w, h = r.right - r.left, r.bottom - r.top
                left, top, width, height = panel_rect
                mon = self.panel_area(left + width // 2, top + 1)
                x = left + max(0, (width - w) // 2)
                y = min(top + height + 16, mon[3] - h - 48)
                user32.SetWindowPos(hwnd, HWND_TOPMOST, x, max(mon[1], y), 0, 0, SWP_NOSIZE)
                return
        threading.Thread(target=run, daemon=True).start()

    # -- the floating focus timer
    def attach_mini(self, win, width, height):
        """Out of the taskbar, rounded, sized in physical pixels (pywebview shrinks
        frameless windows). Returns a handle for the other mini_* calls."""
        hwnd = wt.HWND(win.native.Handle.ToInt64())
        ex = user32.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)
        user32.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW)
        user32.ShowWindow(hwnd, SW_HIDE)
        try:  # DWMWA_WINDOW_CORNER_PREFERENCE = DWMWCP_ROUND (Windows 11)
            pref = ctypes.c_int(2)
            ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, 33, ctypes.byref(pref), ctypes.sizeof(pref))
        except Exception:
            pass
        scale = (user32.GetDpiForWindow(hwnd) or 96) / 96
        handle = {"hwnd": hwnd, "w": round(width * scale), "h": round(height * scale)}
        x, y = self.mini_spot(handle)
        user32.SetWindowPos(hwnd, HWND_TOPMOST, x, y, handle["w"], handle["h"], SWP_NOACTIVATE)
        return handle

    def mini_spot(self, handle):
        """The bottom-right corner of the main screen, clear of the taskbar -
        also while an auto-hide taskbar has slid up."""
        w, h = handle["w"], handle["h"]
        info = _monitor(wt.POINT(0, 0), MONITOR_DEFAULTTOPRIMARY)
        mon, work = info.rcMonitor, info.rcWork
        right, bottom = work.right, work.bottom  # a taskbar that's always shown is outside this
        tray = user32.FindWindowW("Shell_TrayWnd", None)
        r = wt.RECT()
        if tray and user32.IsWindowVisible(tray) and user32.GetWindowRect(tray, ctypes.byref(r)):
            # The part of the taskbar on screen (a hidden auto-hide one leaves a thin line).
            top, left = max(r.top, mon.top), max(r.left, mon.left)
            low, rgt = min(r.bottom, mon.bottom), min(r.right, mon.right)
            if low - top > 4 and rgt - left > 4:
                if rgt - left >= low - top:  # along the bottom (or top) of the screen
                    if top > (mon.top + mon.bottom) // 2:
                        bottom = min(bottom, top)
                elif left > (mon.left + mon.right) // 2:  # down the right-hand side
                    right = min(right, left)
        margin = max(8, h // 4)
        return right - w - margin, bottom - h - margin

    def move_mini(self, handle, x, y):
        user32.SetWindowPos(handle["hwnd"], HWND_TOPMOST, x, y, 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)

    def show_mini(self, handle, show):
        user32.ShowWindow(handle["hwnd"], SW_SHOWNOACTIVATE if show else SW_HIDE)
        if show:  # back on top
            user32.SetWindowPos(handle["hwnd"], HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE)
