"""
Now playing: shows what's playing, with its play / pause / skip buttons. No
account to link: you pick music in the Spotify app, and the dashboard shows it
and controls it.

  Windows: anything in Windows' media pop-up (Spotify, a browser, VLC, Apple
           Music...), through Windows' own media controls (WindowsPlayer).
  Mac:     Spotify and Apple Music, through AppleScript (MacPlayer). macOS
           doesn't let apps read other "now playing" sources any more.

Also runs the focus (Pomodoro) timer - focus, break, focus, break... with
the same lengths until you stop it - and keeps a history of your focus time.
"""

import asyncio
import base64
import datetime as dt
import json
import logging
import os
import re
import subprocess
import sys
import threading
import time
import webbrowser

IS_MAC = sys.platform == "darwin"

FOCUS_FILE = "focus.json"
POLL_SECONDS = 1.0           # how often the player is read while the panel is open
ART_LIMIT = 4_000_000        # largest album art read (bytes)
DAY_STARTS_AT = 4            # focus rounds count towards a day that starts at 4am
LATE_SECONDS = 15 * 60       # a phase that ended this long ago (PC asleep) ends quietly
HISTORY_DAYS = 400           # focus minutes per day are kept this long (for streaks)
ITEMS_KEPT = 300             # coursework whose focus time is remembered

PLAYING, PAUSED, STOPPED, CHANGING = 4, 5, 3, 2
STATUS = {PLAYING: "playing", PAUSED: "paused", STOPPED: "stopped", CHANGING: "changing"}

KNOWN_APPS = [
    ("spotify", "Spotify"), ("msedge", "Edge"), ("chrome", "Chrome"), ("firefox", "Firefox"),
    ("brave", "Brave"), ("opera", "Opera"), ("vlc", "VLC"), ("applemusic", "Apple Music"),
    ("zunemusic", "Media Player"), ("tidal", "TIDAL"), ("deezer", "Deezer"), ("youtube", "YouTube Music"),
]


# ---------------------------------------------------------------- Spotify
def spotify_installed():
    """Is the Spotify desktop app here (the normal installer or the Store app)?"""
    if IS_MAC:
        return any(os.path.isdir(os.path.join(d, "Spotify.app"))
                   for d in ("/Applications", os.path.expanduser("~/Applications")))
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, "spotify"):
            return True
    except OSError:
        pass
    appdata, local = os.environ.get("APPDATA", ""), os.environ.get("LOCALAPPDATA", "")
    if appdata and os.path.exists(os.path.join(appdata, "Spotify", "Spotify.exe")):
        return True
    try:
        return any(name.lower().startswith("spotifyab.spotifymusic") for name in os.listdir(os.path.join(local, "Packages")))
    except OSError:
        return False


def open_spotify():
    """Open the Spotify app (or the web player if it isn't installed)."""
    try:
        if IS_MAC:
            if subprocess.run(["open", "-a", "Spotify"], capture_output=True).returncode != 0:
                raise OSError("Spotify isn't installed")
        else:
            os.startfile("spotify:")
    except OSError:
        webbrowser.open("https://open.spotify.com/")
    return True


def app_name(aumid):
    """Windows' app id ("Spotify.exe", "MSEdge", "...!App") -> a friendly name."""
    low = str(aumid or "").lower()
    for key, name in KNOWN_APPS:
        if key in low:
            return name
    tail = re.sub(r"\.exe$", "", re.split(r"[!\\/]", str(aumid or ""))[-1], flags=re.I)
    return tail[:24] if re.match(r"^[A-Za-z][\w .-]*$", tail) else "Media"


def _day():
    return (dt.datetime.now() - dt.timedelta(hours=DAY_STARTS_AT)).date().isoformat()


def _dur(minutes):
    h, m = divmod(int(minutes), 60)
    return f"{h}h {m}m" if h and m else f"{h}h" if h else f"{m} minute"


def _seconds(td):
    try:
        return max(0.0, td.total_seconds())
    except Exception:
        return 0.0


class PlayerUnavailable(Exception):
    """The player can't work on this computer (the message says why)."""


# ---------------------------------------------------------------- Windows player
class WindowsPlayer:
    """Windows' media sessions (System Media Transport Controls)."""

    def __init__(self):
        self.manager = None
        self.shown_app = ""          # the app on screen, so controls go to the same one
        self.art_key, self.art, self.art_id = None, "", 0

    async def start(self):
        try:
            import winrt.runtime as rt
            import winrt.windows.media.control as wmc
        except ImportError:
            raise PlayerUnavailable("The player needs an add-on: run  python -m pip install -r requirements.txt")
        try:
            rt.init_apartment(rt.MTA)
        except Exception:
            pass  # already initialised on this thread
        try:
            self.manager = await wmc.GlobalSystemMediaTransportControlsSessionManager.request_async()
        except Exception:
            logging.exception("media session manager failed")
            raise PlayerUnavailable("Windows' media controls aren't available on this PC.")

    def _sessions(self):
        try:
            return list(self.manager.get_sessions())
        except Exception:
            logging.debug("get_sessions failed", exc_info=True)
            return []

    def _pick(self):
        """The session to show: one that's playing, then the one already on screen,
        then Spotify, then whatever Windows calls current."""
        sessions = self._sessions()
        if not sessions:
            return None
        try:
            current = self.manager.get_current_session()
            current_id = current.source_app_user_model_id if current else ""
        except Exception:
            current_id = ""

        def score(s):
            aumid = s.source_app_user_model_id or ""
            try:
                playing = int(s.get_playback_info().playback_status) == PLAYING
            except Exception:
                playing = False
            return (playing, aumid == self.shown_app, "spotify" in aumid.lower(), aumid == current_id)
        return max(sessions, key=score)

    async def status(self):
        session = self._pick()
        if session is None:
            return None
        return STATUS.get(int(session.get_playback_info().playback_status), "stopped")

    async def read(self):
        session = self._pick()
        now = await self._describe(session) if session is not None else None
        self.shown_app = now["appId"] if now else ""
        return now

    async def _describe(self, session):
        aumid = session.source_app_user_model_id or ""
        props = await session.try_get_media_properties_async()
        info = session.get_playback_info()
        tl = session.get_timeline_properties()
        controls = info.controls
        start = _seconds(tl.start_time)
        duration = max(0.0, _seconds(tl.end_time) - start)
        position = min(duration, max(0.0, _seconds(tl.position) - start)) if duration else 0.0
        try:
            updated = tl.last_updated_time.timestamp() if tl.last_updated_time.year > 2000 else time.time()
        except Exception:
            updated = time.time()
        title, artist, album = (props.title or "").strip(), (props.artist or "").strip(), (props.album_title or "").strip()
        await self._read_art(props, (aumid, title, artist, album))
        return {
            "appId": aumid,
            "app": app_name(aumid),
            "spotify": "spotify" in aumid.lower(),
            "title": title[:300],
            "artist": artist[:300],
            "album": album[:300],
            "status": STATUS.get(int(info.playback_status), "stopped"),
            "duration": round(duration, 2),
            "position": round(position, 2),
            "updatedAt": round(updated * 1000),
            "canToggle": bool(controls.is_play_pause_toggle_enabled or controls.is_play_enabled or controls.is_pause_enabled),
            "canNext": bool(controls.is_next_enabled),
            "canPrevious": bool(controls.is_previous_enabled),
            "canSeek": bool(controls.is_playback_position_enabled) and duration > 0,
            "art": self.art,
            "artId": self.art_id,
        }

    async def _read_art(self, props, key):
        """Album art as a data: URI, read once per track."""
        if key == self.art_key:
            return
        ref = props.thumbnail
        if ref is None:  # apps often send the art a moment after the title
            if self.art:  # a new track: don't keep showing the last one's art
                self.art, self.art_id = "", self.art_id + 1
            return
        from winrt.windows.storage.streams import DataReader
        stream = await ref.open_read_async()
        size = int(stream.size or 0)
        if not 0 < size <= ART_LIMIT:
            return
        reader = DataReader(stream)
        await reader.load_async(size)
        data = bytes(reader.read_buffer(size))
        mime = str(stream.content_type or "")
        if not re.match(r"^image/[a-z0-9.+-]+$", mime):
            mime = "image/jpeg" if data[:2] == b"\xff\xd8" else "image/png"
        self.art = f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"
        self.art_key, self.art_id = key, self.art_id + 1

    async def command(self, action, value=None):
        session = self._pick()
        if session is None:
            return False
        if action == "toggle":
            return bool(await session.try_toggle_play_pause_async())
        if action == "play":
            return bool(await session.try_play_async())
        if action == "pause":
            return bool(await session.try_pause_async())
        if action == "next":
            return bool(await session.try_skip_next_async())
        if action == "previous":
            return bool(await session.try_skip_previous_async())
        start = _seconds(session.get_timeline_properties().start_time)
        return bool(await session.try_change_playback_position_async(int((start + float(value)) * 10_000_000)))


# ---------------------------------------------------------------- Mac player
# One AppleScript call reads Spotify, or else Apple Music (only apps that are
# already running: asking a closed app would open it). The first time, macOS
# asks whether the dashboard may control Spotify / Music.
# (Spotify's part is only included when Spotify is installed: mentioning an app
# that isn't there makes macOS ask "Where is Spotify?".)
MAC_SPOTIFY = """
if application "Spotify" is running then
    tell application "Spotify"
        if player state is stopped then return "Spotify" & linefeed & "stopped"
        set t to current track
        return "Spotify" & linefeed & (player state as text) & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (album of t) & linefeed & ((duration of t) / 1000 as text) & linefeed & (player position as text) & linefeed & (artwork url of t)
    end tell
end if
"""
MAC_MUSIC = """
if application "Music" is running then
    tell application "Music"
        if player state is stopped then return "Music" & linefeed & "stopped"
        set t to current track
        return "Music" & linefeed & (player state as text) & linefeed & (name of t) & linefeed & (artist of t) & linefeed & (album of t) & linefeed & (duration of t as text) & linefeed & (player position as text) & linefeed
    end tell
end if
return ""
"""
MAC_COMMANDS = {"toggle": "playpause", "play": "play", "pause": "pause", "next": "next track", "previous": "previous track"}


class MacPlayer:
    """Spotify and Apple Music on a Mac, through AppleScript."""

    def __init__(self):
        self.app = ""
        self.script = (MAC_SPOTIFY if spotify_installed() else "") + MAC_MUSIC

    async def start(self):
        if not os.path.exists("/usr/bin/osascript"):
            raise PlayerUnavailable("AppleScript isn't available on this Mac.")

    async def _run(self, script):
        def run():
            r = subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True, timeout=5)
            if r.returncode != 0:
                logging.debug("osascript: %s", r.stderr.strip())
            return r.stdout.strip() if r.returncode == 0 else ""
        return await asyncio.get_running_loop().run_in_executor(None, run)

    async def read(self):
        lines = (await self._run(self.script)).split("\n")
        if len(lines) < 2:
            self.app = ""
            return None
        self.app = lines[0]
        if lines[1] == "stopped" or len(lines) < 7:
            return None
        num = lambda v: float(str(v).replace(",", ".") or 0)  # some locales write 1,5
        duration, position = num(lines[5]), num(lines[6])
        art = lines[7] if len(lines) > 7 and lines[7].startswith("https://") else ""
        return {
            "appId": self.app,
            "app": "Apple Music" if self.app == "Music" else self.app,
            "spotify": self.app == "Spotify",
            "title": lines[2][:300],
            "artist": lines[3][:300],
            "album": lines[4][:300],
            "status": "playing" if lines[1] == "playing" else "paused",
            "duration": round(duration, 2),
            "position": round(min(position, duration or position), 2),
            "updatedAt": round(time.time() * 1000),
            "canToggle": True, "canNext": True, "canPrevious": True, "canSeek": duration > 0,
            "art": art,  # Spotify gives a link to the cover (Apple Music: no cover)
            "artId": hash(art) & 0xFFFFFF,
        }

    async def status(self):
        now = await self.read()
        return now["status"] if now else None

    async def command(self, action, value=None):
        if not self.app:
            await self.read()
        if not self.app:
            return False
        if action == "seek":
            verb = f"set player position to {float(value):.1f}"
        else:
            verb = MAC_COMMANDS[action]
        return await self._run(f'tell application "{self.app}" to {verb}\nreturn "ok"') == "ok"


# ---------------------------------------------------------------- player + focus timer
class Media:
    def __init__(self, folder, on_update, notify):
        self.focus_path = os.path.join(folder, FOCUS_FILE)
        self.on_update = on_update   # on_update(snapshot) whenever something visible changes
        self.notify = notify         # notify(title, message, kind)
        self.lock = threading.Lock()
        self.loop = None
        self.wake = None
        self.ready = threading.Event()
        self.player = None           # WindowsPlayer or MacPlayer, once it's working
        self.active = False          # panel open: read the player every second
        self.available = True
        self.error = ""
        self.now = None              # what's playing (dict) or None
        self.pushed = None
        self.spotify = spotify_installed()
        self.focus = self._load_focus()

    # -- focus state on disk (a running timer survives a restart)
    def _load_focus(self):
        focus = {"phase": "", "endsAt": 0.0, "length": 0, "breakMinutes": 5, "pause": True,
                 "pausedMusic": False, "focusLength": 0, "day": _day(), "rounds": 0, "minutes": 0, "history": {},
                 "subject": {}, "byItem": {}, "mini": True, "goal": 0}
        try:
            with open(self.focus_path, encoding="utf-8-sig") as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                for key, value in saved.items():
                    if key in focus and isinstance(value, type(focus[key])):
                        focus[key] = value
        except FileNotFoundError:
            pass
        except Exception:
            logging.exception("could not read %s", self.focus_path)
        if focus["phase"] not in ("", "focus", "break"):
            focus["phase"] = ""
        return focus

    def _save_focus(self):
        tmp = self.focus_path + ".tmp"
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.focus, f, indent=1)
            os.replace(tmp, self.focus_path)
        except OSError:
            logging.exception("could not save %s", self.focus_path)

    # -- what the page sees
    def snapshot(self):
        with self.lock:
            f = self.focus
            today = f["day"] == _day()
            return {
                "available": self.available,
                "error": self.error,
                "spotifyInstalled": self.spotify,
                "now": dict(self.now) if self.now else None,
                "focus": {
                    "phase": f["phase"],
                    "endsAt": round(f["endsAt"] * 1000),
                    "length": f["length"],
                    "rounds": f["rounds"] if today else 0,
                    "minutes": f["minutes"] if today else 0,
                    "history": dict(f["history"]),  # {"2026-10-19": minutes}
                    "subject": dict(f["subject"]),  # what you're focusing on: {"id", "title"}
                    "byItem": {k: dict(v) for k, v in f["byItem"].items()},  # {id: {"title", "minutes"}}
                    "mini": f["mini"],
                },
            }

    def _push(self, force=False):
        snap = self.snapshot()
        now = snap["now"]
        key = dict(snap, now=None)
        if now:
            # Pushed again when the track, state or art changes, or after a seek
            # (the page moves the progress bar along by itself in between).
            anchor = now["updatedAt"] / 1000 - now["position"] if now["status"] == "playing" else now["position"]
            key["now"] = dict(now, art=now["artId"], position=round(anchor / 2), updatedAt=0)
        key = json.dumps(key, sort_keys=True)
        if force or key != self.pushed:
            self.pushed = key
            try:
                self.on_update(snap)
            except Exception:
                logging.exception("media update failed")

    # -- the background thread
    def run(self, stopping):
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        try:
            self.loop.run_until_complete(self._main(stopping))
        except Exception:
            logging.exception("media loop stopped")
        finally:
            self.loop.close()

    async def _main(self, stopping):
        self.wake = asyncio.Event()
        self.focus_busy = asyncio.Lock()  # one focus change at a time (they await the player)
        self.ready.set()
        player = MacPlayer() if IS_MAC else WindowsPlayer()
        try:
            await player.start()
            self.player = player
        except PlayerUnavailable as e:
            self.available = False
            self.error = str(e)
            logging.warning("media player off: %s", e)
        self._push(force=True)

        while not stopping.is_set():
            try:
                await self._check_focus()
                if self.active and self.player is not None:
                    await self.refresh()
            except Exception:
                logging.exception("media loop error")
            timeout = POLL_SECONDS if self.active else 30
            with self.lock:
                if self.focus["phase"]:
                    timeout = min(timeout, max(0.2, self.focus["endsAt"] - time.time()))
            try:
                await asyncio.wait_for(self.wake.wait(), timeout)
            except asyncio.TimeoutError:
                pass
            self.wake.clear()

    def _wakeup(self):
        if self.loop is not None and self.wake is not None:
            self.loop.call_soon_threadsafe(self.wake.set)

    def _call(self, coro, timeout=6):
        """Run a coroutine on the media thread and wait for its result."""
        if not self.ready.wait(5) or self.loop is None or self.loop.is_closed():
            coro.close()
            return False
        try:
            return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)
        except Exception:
            logging.exception("media command failed")
            return False

    def set_active(self, on):
        """The panel opened (read the player every second) or closed (stop reading it)."""
        self.active = bool(on)
        if on:
            self._wakeup()

    # -- reading the player
    async def refresh(self):
        try:
            self.now = await self.player.read()
        except Exception:
            logging.debug("could not read the player", exc_info=True)
        self._push()

    async def _status(self):
        """"playing" / "paused" / "stopped", or None when nothing is playing."""
        if self.player is None:
            return None
        try:
            return await self.player.status()
        except Exception:
            logging.debug("could not read the player", exc_info=True)
            return None

    async def _do(self, action):
        try:
            return bool(await self.player.command(action)) if self.player is not None else False
        except Exception:
            logging.debug("player %s failed", action, exc_info=True)
            return False

    # -- controls
    def command(self, action, value=None):
        """play / pause / toggle / next / previous / seek (value = seconds)."""
        if action not in ("play", "pause", "toggle", "next", "previous", "seek"):
            return False
        return self._call(self._command(action, value))

    async def _command(self, action, value):
        if self.player is None:
            return False
        if action == "seek":
            try:
                value = max(0.0, float(value))
            except (TypeError, ValueError):
                return False
        ok = await self.player.command(action, value)
        await asyncio.sleep(0.3)  # give the app a moment to catch up
        await self.refresh()
        return bool(ok)

    # -- focus timer
    def focus_start(self, minutes, break_minutes, pause_for_breaks, subject=None, mini=True, goal=0):
        """subject: the coursework you're working on, {"id", "title"} (optional).
        goal: your daily focus goal in minutes (0 = none), for the "goal reached" note."""
        subject = subject if isinstance(subject, dict) else {}
        subject = {"id": str(subject.get("id") or "")[:100], "title": str(subject.get("title") or "")[:200]}
        try:
            goal = max(0, min(1440, int(float(goal or 0))))
        except (TypeError, ValueError):
            goal = 0
        return self._call(self._focus_start(minutes, break_minutes, pause_for_breaks,
                                            subject if subject["id"] else {}, bool(mini), goal))

    def focus_stop(self):
        return self._call(self._focus_stop())

    def focus_skip(self):
        """End the current focus session or break now."""
        return self._call(self._focus_skip())

    async def _focus_start(self, minutes, break_minutes, pause_for_breaks, subject, mini, goal):
        async with self.focus_busy:
            return await self._start_focus(minutes, break_minutes, pause_for_breaks, subject, mini, goal)

    async def _start_focus(self, minutes, break_minutes, pause_for_breaks, subject, mini, goal):
        minutes = max(1, min(180, int(float(minutes or 25))))
        break_minutes = max(1, min(60, int(float(break_minutes or 5))))
        with self.lock:
            # focusLength: each round after a break is this long again.
            self.focus.update(phase="focus", endsAt=time.time() + minutes * 60, length=minutes * 60,
                              focusLength=minutes * 60, breakMinutes=break_minutes, pause=False,
                              pausedMusic=False, subject=subject, mini=mini, goal=goal)
            self._save_focus()
        # Music to focus to: carry on with whatever is paused.
        if await self._status() == "paused":
            await self._do("play")
        if self.player is not None:
            await self.refresh()
        self._push(force=True)
        self._wakeup()
        return True

    async def _focus_stop(self):
        async with self.focus_busy:
            with self.lock:
                self.focus.update(phase="", endsAt=0.0, length=0, pausedMusic=False)
                self._save_focus()
        self._push(force=True)
        return True

    async def _focus_skip(self):
        async with self.focus_busy:
            with self.lock:
                f = self.focus
                if f["phase"] == "focus":  # count the time you did focus
                    f["length"] = max(0, round(f["length"] - (f["endsAt"] - time.time())))
                if f["phase"]:
                    f["endsAt"] = time.time()
            await self._end_phase(skipped=True)
        return True

    def _streak(self, goal):
        """Days in a row (ending today) with at least `goal` minutes of focus."""
        day, n = dt.date.fromisoformat(_day()), 0
        while self.focus["history"].get(day.isoformat(), 0) >= goal and n < HISTORY_DAYS:
            n += 1
            day -= dt.timedelta(days=1)
        return n

    def _notify_later(self, title, message, kind):
        threading.Thread(target=self.notify, args=(title, message, kind), daemon=True).start()

    async def _check_focus(self):
        async with self.focus_busy:
            await self._end_phase(skipped=False)

    async def _end_phase(self, skipped):
        """Focus over: a break. Break over: the next focus session, the same length
        as the last one, and so on until you stop the timer. Your music keeps playing."""
        with self.lock:
            f = self.focus
            phase, ends = f["phase"], f["endsAt"]
        if not phase or time.time() < ends:
            return
        late = time.time() - ends > LATE_SECONDS
        if phase == "focus":
            goal_note = ""
            with self.lock:
                if f["day"] != _day():
                    f.update(day=_day(), rounds=0, minutes=0)
                before = f["history"].get(_day(), 0)
                if f["length"] >= 60:
                    f["rounds"] += 1
                    f["minutes"] += round(f["length"] / 60)
                    day = _day()
                    f["history"][day] = f["history"].get(day, 0) + round(f["length"] / 60)
                    for old in sorted(f["history"])[:-HISTORY_DAYS]:
                        del f["history"][old]
                    if f["subject"].get("id"):  # time spent on that coursework
                        item = f["byItem"].pop(f["subject"]["id"], {"minutes": 0})
                        item.update(title=f["subject"].get("title", ""), minutes=item.get("minutes", 0) + round(f["length"] / 60))
                        f["byItem"][f["subject"]["id"]] = item  # most recent last
                        for old in list(f["byItem"])[:-ITEMS_KEPT]:
                            del f["byItem"][old]
                    goal = f.get("goal") or 0
                    if goal and before < goal <= f["history"][day]:
                        streak = self._streak(goal)
                        goal_note = f"That's your {_dur(goal)} goal for today"
                        goal_note += f" - {streak} days in a row!" if streak > 1 else "!"
            if late:
                with self.lock:
                    f.update(phase="", endsAt=0.0, length=0, pausedMusic=False)
            else:
                with self.lock:
                    f.update(phase="break", endsAt=time.time() + f["breakMinutes"] * 60,
                             length=f["breakMinutes"] * 60, pausedMusic=False)
                if not skipped or goal_note:
                    self._notify_later("Daily goal reached" if goal_note else "Focus session done",
                                       (goal_note + " " if goal_note else "Nice work. ")
                                       + f"Take a {f['breakMinutes']} minute break.",
                                       "goal" if goal_note else "break")
        else:
            # Break over: straight into the next round (unless the computer was
            # asleep through it - then the timer just stops).
            length = f.get("focusLength") or 0
            with self.lock:
                if late or not length:
                    f.update(phase="", endsAt=0.0, length=0, pausedMusic=False)
                else:
                    f.update(phase="focus", endsAt=time.time() + length, length=length, pausedMusic=False)
            if not skipped and not late and length:
                self._notify_later("Break over", f"Next {round(length / 60)} minute focus session started. "
                                   "Stop the timer on the dashboard when you're done.", "focus")
        with self.lock:
            self._save_focus()
        if self.active and self.player is not None:
            await self.refresh()
        self._push(force=True)
