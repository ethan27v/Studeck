"""
Reads your deadlines (Learn, Moodle, Canvas... any calendar link) and
university timetable from their calendar (.ics) links, so the dashboard fills
itself in. From the timetable it also works out your semesters: when teaching
starts and ends, break weeks, and which courses you're taking.

The links live in calendar-links.txt. Results are cached in feeds-cache.json
so the dashboard still shows your last-known timetable when you're offline.
"""

import collections
import copy
import datetime as dt
import hashlib
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.request

LINKS_FILE = "calendar-links.txt"
CACHE_FILE = "feeds-cache.json"
REFRESH_SECONDS = 15 * 60
KINDS = ("learn", "timetable")

LINKS_TEMPLATE = """\
# Calendar links for Studeck
# ----------------------------------------
# The easiest way to set these is the Settings window (tray / menu bar icon >
# Settings). Or paste each private link after the = sign here and save; the
# dashboard picks it up within a few seconds. Keep these links private: anyone
# who has one can read that calendar.
#
# DEADLINES - your learning site's calendar (Moodle, Canvas, Blackboard...)
#   e.g. Canvas: Calendar > "Calendar Feed" (bottom right) > copy the link
learn =
#
# TIMETABLE (classes) - your uni timetable's calendar link: look for
#   "Subscribe", "Export" or "iCal" on your timetable website, or publish the
#   Outlook / Google calendar it's in and copy the ICS link (not the HTML one)
timetable =
"""
TERM_GAP_DAYS = 14   # a gap this long with no classes starts a new semester
YEAR_GAP_DAYS = 84   # ...and one this long (the summer holidays) a new academic year

DEADLINE_WORDS = re.compile(r"\b(due|deadline|submission|submit)\b", re.I)
KIND_WORDS = re.compile(r"\b(lecture|tutorial|workshop|seminar|lab|practical|recital|exam)\b", re.I)


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


class FeedError(Exception):
    """A problem worth showing to the user, in plain words."""


# ---------------------------------------------------------------- links file
def read_links(path):
    """{'learn': url, 'timetable': url} - empty strings for missing links."""
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            f.write(LINKS_TEMPLATE)
    links = {kind: "" for kind in KINDS}
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().lower()
            value = value.strip().strip('"').strip("'").strip()
            if key in links:
                if value.lower().startswith("webcal://"):
                    value = "https://" + value[len("webcal://"):]
                links[key] = value
    return links


def write_links(path, links):
    """Save links (from the Settings window) into the links file."""
    text = LINKS_TEMPLATE
    for kind in KINDS:
        text = re.sub(rf"(?m)^{kind} =$", f"{kind} = {links.get(kind, '')}".rstrip(), text)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    replace_file(tmp, path)


# ---------------------------------------------------------------- download
_SSL = None


def _ssl_context():
    """HTTPS using certifi's certificates when it's installed: Python from
    python.org on a Mac has none of its own until you run its certificate setup."""
    global _SSL
    if _SSL is None:
        import ssl
        try:
            import certifi
            _SSL = ssl.create_default_context(cafile=certifi.where())
        except ImportError:
            _SSL = ssl.create_default_context()
    return _SSL


def fetch(url, timeout=25):
    if not re.match(r"^(https?|file)://", url, re.I):
        raise FeedError("That doesn't look like a link. It should start with https://")
    req = urllib.request.Request(url, headers={"User-Agent": "Studeck/1.0", "Accept": "text/calendar, */*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=_ssl_context()) as resp:
            data = resp.read(30_000_000)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise FeedError("Access denied. The link may have been reset - copy a fresh one.") from e
        if e.code in (404, 410):
            raise FeedError("Link not found - copy it again.") from e
        raise FeedError(f"The calendar server returned an error ({e.code}).") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise FeedError("Couldn't connect - are you offline?") from e
    head = data[:2048].lstrip(b"\xef\xbb\xbf \t\r\n").upper()
    if not head.startswith(b"BEGIN:VCALENDAR"):
        raise FeedError("That link didn't return a calendar. Make sure you copied the ICS link.")
    return data


# ---------------------------------------------------------------- parsing
def _text(value):
    if value is None:
        return ""
    if isinstance(value, list):
        return ", ".join(_text(v) for v in value)
    cats = getattr(value, "cats", None)  # CATEGORIES
    if cats is not None:
        return ", ".join(str(c) for c in cats)
    return str(value).strip()


def _local(value):
    """datetime -> naive local datetime; date stays a date."""
    if isinstance(value, dt.datetime):
        return value.astimezone().replace(tzinfo=None) if value.tzinfo else value
    return value


def _events(data, start, end):
    try:
        import icalendar
        import recurring_ical_events
    except ImportError as e:
        raise FeedError("Missing add-on: run  python -m pip install icalendar recurring-ical-events tzdata") from e

    cal = icalendar.Calendar.from_ical(data)
    try:
        query = recurring_ical_events.of(cal, skip_bad_series=True)
    except TypeError:
        query = recurring_ical_events.of(cal)
    for ev in query.between(start, end):
        if _text(ev.get("STATUS")).upper() == "CANCELLED":
            continue
        try:
            begin = _local(ev.decoded("DTSTART"))
        except KeyError:
            continue
        if "DTEND" in ev:
            finish = _local(ev.decoded("DTEND"))
        elif "DURATION" in ev:
            finish = begin + ev.decoded("DURATION")
        else:
            finish = begin
        yield ev, begin, finish


def _base(ev, begin):
    uid = _text(ev.get("UID")) or _text(ev.get("SUMMARY"))
    stamp = begin.isoformat() if isinstance(begin, (dt.date, dt.datetime)) else ""
    return {
        "id": hashlib.sha1(f"{uid}|{stamp}".encode("utf-8")).hexdigest()[:16],
        "title": _text(ev.get("SUMMARY")) or "Busy",
        "room": _text(ev.get("LOCATION")),
        "course": _text(ev.get("CATEGORIES")),
        "desc": _text(ev.get("DESCRIPTION"))[:400],
    }


def _class_details(title, desc):
    """Pull course, class type, group and staff out of a uni timetable entry.

    Titles look like "Software Testing - Tutorial/04", and the description has
    lines like "Event Type" / "Tutorial" and "Staff" / "Name".
    """
    def field(name):
        m = re.search(rf"(?:^|\n){name}\s*\n+\s*([^\n]+)", desc)
        return m.group(1).strip() if m else ""

    course, _, activity = title.partition(" - ")
    activity = activity.strip()
    group = ""
    m = re.search(r"/\s*(\w+)\s*$", activity)
    if m:
        group = m.group(1)
        activity = activity[:m.start()].strip()
    kind = field("Event Type")
    if not kind or kind.lower() == "activity":
        found = KIND_WORDS.search(activity) or KIND_WORDS.search(title)
        kind = activity or (found.group(1).title() if found else "")
    if desc.lstrip().lower().startswith("please see exam details") or re.match(r"(?i)exam\b", title):
        kind = "Exam"
    return {
        "course": course.strip() if activity else "",
        "kind": kind,
        "group": group,
        "staff": field("Staff"),
    }


def _as_event(ev, begin, finish):
    item = _base(ev, begin)
    details = _class_details(item["title"], _text(ev.get("DESCRIPTION")))
    item.update(kind=details["kind"], group=details["group"], staff=details["staff"])
    if not item["course"]:
        item["course"] = details["course"]
    if isinstance(begin, dt.datetime):
        last = finish if isinstance(finish, dt.datetime) and finish > begin else begin
        end_time = last.strftime("%H:%M") if last.date() == begin.date() else "23:59"
        item.update(date=begin.date().isoformat(), start=begin.strftime("%H:%M"), end=end_time, allDay=False)
    else:
        last = finish - dt.timedelta(days=1) if isinstance(finish, dt.date) and finish > begin else begin
        item.update(date=begin.isoformat(), endDate=last.isoformat(), allDay=True)
    return item


def parse_timetable(data, today):
    monday = today - dt.timedelta(days=today.weekday())
    start = dt.datetime.combine(monday - dt.timedelta(days=7), dt.time())
    end = dt.datetime.combine(today + dt.timedelta(days=43), dt.time())
    events = [_as_event(ev, b, f) for ev, b, f in _events(data, start, end)]
    events.sort(key=lambda e: (e["date"], not e["allDay"], e.get("start", "")))
    try:
        terms = detect_terms(data, today)
    except Exception:
        logging.exception("could not work out the semesters")
        terms = []
    return {"events": events, "terms": terms}


def _course_of(ev):
    """The course a timetable entry belongs to ("Software Testing - Tutorial/04"
    -> "Software Testing"); for other formats, the title without class words."""
    title = _text(ev.get("SUMMARY"))
    course = _text(ev.get("CATEGORIES")) or _class_details(title, _text(ev.get("DESCRIPTION")))["course"]
    if not course:
        course = re.sub(r"\s*[-–:/(]?\s*" + KIND_WORDS.pattern + r".*$", "", title, flags=re.I)
        course = re.sub(r"\s*[/#]\s*\w+$", "", course).strip(" -–:")
    return course[:120]


def detect_terms(data, today):
    """The semesters in a timetable: blocks of teaching weeks separated by a
    gap of TERM_GAP_DAYS or more (e.g. the winter break).

    They're numbered in order through the academic year - the count starts
    again after a gap of YEAR_GAP_DAYS or more - so it works whenever your
    year starts (September, February...) and however many terms it has.

    [{"name", "number", "start" (Monday of week 1), "end" (last class), "weeks",
      "breakWeeks" (weeks inside the block with no classes), "courses"}]
    """
    start = dt.datetime.combine(today - dt.timedelta(days=330), dt.time())
    end = dt.datetime.combine(today + dt.timedelta(days=330), dt.time())
    days = collections.defaultdict(list)  # date -> courses taught that day
    for ev, begin, _finish in _events(data, start, end):
        if not isinstance(begin, dt.datetime):
            continue  # all-day entries (holidays, notes) aren't classes
        title, desc = _text(ev.get("SUMMARY")), _text(ev.get("DESCRIPTION"))
        if _class_details(title, desc)["kind"] == "Exam":
            continue  # exams aren't teaching weeks
        days[begin.date()].append(_course_of(ev))
    blocks, current = [], []
    for day in sorted(days):
        if current and (day - current[-1]).days > TERM_GAP_DAYS:
            blocks.append(current)
            current = []
        current.append(day)
    if current:
        blocks.append(current)
    terms = []
    for block in blocks:
        first, last = block[0], block[-1]
        monday = first - dt.timedelta(days=first.weekday())
        weeks = (last - monday).days // 7 + 1
        if weeks < 3 or len(block) < 6:
            continue  # a few stray events, not a semester
        taught = {(d - monday).days // 7 + 1 for d in block}
        counts = collections.Counter(c for d in block for c in days[d] if c)
        terms.append({
            "start": monday.isoformat(),
            "end": last.isoformat(),
            "weeks": weeks,
            "breakWeeks": [w for w in range(1, weeks + 1) if w not in taught],
            "courses": [c for c, n in counts.most_common(25) if n >= 2],
        })
    _number_terms(terms)
    return terms


def _number_terms(terms):
    """Semester 1, 2... in order through each academic year."""
    years = []
    for t in terms:
        if years and (dt.date.fromisoformat(t["start"]) - dt.date.fromisoformat(years[-1][-1]["end"])).days < YEAR_GAP_DAYS:
            years[-1].append(t)
        else:
            years.append([t])
    for i, year in enumerate(years):
        first = 1
        # The timetable may begin part-way through a year (only this year's
        # second semester, say): line it up with the end of the next year.
        if i == 0 and len(years) > 1 and len(year) < len(years[1]):
            first = len(years[1]) - len(year) + 1
        for n, t in enumerate(year, first):
            t["number"] = n
            t["name"] = f"Semester {n}"


def parse_learn(data, today):
    start = dt.datetime.combine(today - dt.timedelta(days=7), dt.time())
    end = dt.datetime.combine(today + dt.timedelta(days=200), dt.time())
    deadlines, events = [], []
    for ev, begin, finish in _events(data, start, end):
        timed = isinstance(begin, dt.datetime)
        zero_length = timed and (not isinstance(finish, dt.datetime) or finish <= begin)
        title = _text(ev.get("SUMMARY"))
        if zero_length or (timed and DEADLINE_WORDS.search(title)):
            item = _base(ev, begin)
            item.update(date=begin.date().isoformat(), time=begin.strftime("%H:%M"))
            deadlines.append(item)
        else:
            events.append(_as_event(ev, begin, finish))
    deadlines.sort(key=lambda d: (d["date"], d["time"], d["title"]))
    events.sort(key=lambda e: (e["date"], not e["allDay"], e.get("start", "")))
    return {"deadlines": deadlines, "events": events}


PARSERS = {"learn": parse_learn, "timetable": parse_timetable}


def parse_ics_events(data, today, past_days=14, future_days=400, limit=500):
    """Events from a module's .ics file (or link), for importing as coursework.

    Returns {"name": calendar name, "events": [{summary, desc, location, date,
    time, minutes, allDay}]}, recurring events expanded, times in local time.
    """
    import icalendar

    start = dt.datetime.combine(today - dt.timedelta(days=past_days), dt.time())
    end = dt.datetime.combine(today + dt.timedelta(days=future_days), dt.time())
    name = _text(icalendar.Calendar.from_ical(data).get("X-WR-CALNAME"))
    events = []
    for ev, begin, finish in _events(data, start, end):
        timed = isinstance(begin, dt.datetime)
        minutes = None
        end_date, end_time = "", ""
        if timed and isinstance(finish, dt.datetime):
            minutes = max(0, int((finish - begin).total_seconds() // 60))
            end_date, end_time = finish.date().isoformat(), finish.strftime("%H:%M")
        elif not timed and isinstance(finish, dt.date) and not isinstance(finish, dt.datetime):
            end_date = (finish - dt.timedelta(days=1)).isoformat()  # DTEND is exclusive
        events.append({
            "endDate": end_date,
            "endTime": end_time,
            "summary": _text(ev.get("SUMMARY")),
            "desc": _text(ev.get("DESCRIPTION"))[:400],
            "location": _text(ev.get("LOCATION"))[:200],
            "date": (begin.date() if timed else begin).isoformat(),
            "time": begin.strftime("%H:%M") if timed else "",
            "minutes": minutes,
            "allDay": not timed,
        })
        if len(events) >= 20 * limit:  # safety net for huge calendars
            break
    events.sort(key=lambda e: (e["date"], e["time"]))
    return {"name": name, "events": events[:limit]}

_WARM_UP_ICS = b"""BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:warm-up\r
SUMMARY:x\r
DTSTART:20260101T090000Z\r
DTEND;TZID=Europe/London:20260101T100000\r
END:VEVENT\r
END:VCALENDAR\r
"""


def warm_up():
    """Import the calendar libraries and their timezone data up front."""
    try:
        today = dt.date.today()
        parse_learn(_WARM_UP_ICS, today)
    except Exception:
        logging.debug("calendar warm-up failed", exc_info=True)


# ---------------------------------------------------------------- manager
class Feeds:
    """Keeps both feeds fresh in a background thread."""

    def __init__(self, folder, on_update):
        self.links_path = os.path.join(folder, LINKS_FILE)
        self.cache_path = os.path.join(folder, CACHE_FILE)
        self.on_update = on_update
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.fail_streak = 0
        self.last_digest = {}  # kind -> fingerprint of the last calendar read
        self.state = self._load_cache()

    def _empty(self):
        return {"configured": False, "ok": False, "updated": "", "error": "", "link": "", "events": [], "deadlines": [], "terms": []}

    def _load_cache(self):
        state = {kind: self._empty() for kind in KINDS}
        try:
            with open(self.cache_path, encoding="utf-8-sig") as f:
                saved = json.load(f)
            for kind in KINDS:
                if isinstance(saved.get(kind), dict):
                    state[kind].update(saved[kind])
                    state[kind]["ok"] = False  # not confirmed until the next fetch
        except FileNotFoundError:
            pass
        except Exception:
            logging.exception("could not read %s", self.cache_path)
        return state

    def _save_cache(self):
        tmp = self.cache_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f)
        replace_file(tmp, self.cache_path)

    def snapshot(self):
        with self.lock:
            snap = copy.deepcopy(self.state)
        for kind in KINDS:
            snap[kind].pop("link", None)
        return snap

    def refresh(self):
        try:
            links = read_links(self.links_path)
        except Exception:
            logging.exception("could not read %s", self.links_path)
            return
        today = dt.date.today()
        for kind in KINDS:
            url = links[kind]
            # Only a fingerprint of the link is cached, never the link itself.
            fingerprint = hashlib.sha256(url.encode("utf-8")).hexdigest()[:16] if url else ""
            with self.lock:
                entry = self.state[kind]
                if entry.get("link") != fingerprint:  # link changed or removed: forget old data
                    self.state[kind] = entry = self._empty()
                    entry["link"] = fingerprint
                entry["configured"] = bool(url)
            if not url:
                continue
            try:
                data = fetch(url)
                # Same calendar as last time (and the same day)? Skip re-reading
                # it - expanding repeating events is the costly part.
                digest = hashlib.sha256(data).hexdigest()[:16] + today.isoformat()
                if digest == self.last_digest.get(kind) and entry.get("ok"):
                    with self.lock:
                        entry.update(updated=dt.datetime.now().strftime("%Y-%m-%dT%H:%M"))
                    continue
                parsed = PARSERS[kind](data, today)
                self.last_digest[kind] = digest
                with self.lock:
                    entry.update(parsed)
                    entry.update(ok=True, error="", updated=dt.datetime.now().strftime("%Y-%m-%dT%H:%M"))
                logging.info("%s feed: %d events, %d deadlines", kind, len(entry["events"]), len(entry["deadlines"]))
            except FeedError as e:
                with self.lock:
                    entry.update(ok=False, error=str(e))
                logging.warning("%s feed: %s", kind, e)
            except Exception as e:
                with self.lock:
                    entry.update(ok=False, error="Couldn't read that calendar.")
                logging.exception("%s feed failed: %s", kind, e)
        with self.lock:
            try:
                self._save_cache()
            except Exception:
                logging.exception("could not write %s", self.cache_path)
        self.on_update()

    def trigger(self):
        self.wake.set()

    def run(self, stopping):
        def links_mtime():
            try:
                return os.path.getmtime(self.links_path)
            except OSError:
                return None

        while not stopping.is_set():
            self.wake.clear()
            self.refresh()
            seen = links_mtime()
            # A calendar that failed (e.g. no network yet just after switching on)
            # is retried after 1 minute, then 2, 4, 8... up to the normal 15.
            failing = any(e.get("configured") and not e.get("ok") for e in self.state.values())
            self.fail_streak = self.fail_streak + 1 if failing else 0
            wait = min(REFRESH_SECONDS, 60 * 2 ** (self.fail_streak - 1)) if failing else REFRESH_SECONDS
            deadline = dt.datetime.now() + dt.timedelta(seconds=wait)
            while not stopping.is_set() and dt.datetime.now() < deadline:
                if self.wake.wait(2) or links_mtime() != seen:
                    if links_mtime() != seen:
                        stopping.wait(0.5)  # let the editor finish saving
                    break
