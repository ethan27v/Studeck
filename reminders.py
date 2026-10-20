"""
Reminders, as Windows notifications:
  - coursework: 3 days before, 1 day before, and on the morning it's due
  - interviews: the day before and 1 hour before

The page sends the list of upcoming coursework (not yet submitted) and
interviews; this module decides when to notify. What has already been sent is
remembered in reminders.json, so restarting the dashboard never repeats a
reminder, and a reminder missed while the PC was off is sent once when it next
starts.
"""

import datetime as dt
import json
import logging
import os
import re
import threading
import time

REMINDERS_FILE = "reminders.json"
MORNING = dt.time(8, 30)
DEFAULT_DUE_TIME = dt.time(23, 59)        # coursework added without a time
DEFAULT_INTERVIEW_TIME = dt.time(9, 0)    # interview added without a time

# (stage name, how long before) - coursework's morning stage is added separately
STAGES = [("3d", dt.timedelta(days=3)), ("1d", dt.timedelta(days=1))]
INTERVIEW_STAGES = [("1d", dt.timedelta(days=1)), ("1h", dt.timedelta(hours=1))]


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


def _due_datetime(item):
    try:
        day = dt.date.fromisoformat(str(item.get("due", "")))
    except ValueError:
        return None
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(item.get("time") or ""))
    if m and int(m.group(1)) < 24 and int(m.group(2)) < 60:
        at = dt.time(int(m.group(1)), int(m.group(2)))
    else:
        at = DEFAULT_INTERVIEW_TIME if item.get("kind") == "interview" else DEFAULT_DUE_TIME
    return dt.datetime.combine(day, at)


def stages_for(due, kind="coursework"):
    """[(name, trigger time)] in order, earliest first."""
    if kind == "interview":
        return [(name, due - before) for name, before in INTERVIEW_STAGES]
    out = [(name, due - before) for name, before in STAGES]
    morning = dt.datetime.combine(due.date(), MORNING)
    # A morning reminder only makes sense if it comes a while before the deadline.
    if morning <= due - dt.timedelta(hours=1) and morning > out[-1][1]:
        out.append(("day", morning))
    return out


def item_key(item):
    # Includes the date/time, so moving a deadline or interview starts its reminders afresh.
    return f"{item.get('id')}|{item.get('due')}|{item.get('time') or ''}"


def due_reminder(item, now, sent):
    """The reminder to send for this item right now, or None.

    `sent` is the list of stage names already sent for it. Only the latest
    stage that has come due is returned, so a PC that was switched off doesn't
    get a burst of out-of-date reminders.
    """
    due = _due_datetime(item)
    if due is None or now >= due:
        return None
    current = [name for name, at in stages_for(due, item.get("kind")) if at <= now]
    if not current or current[-1] in sent:
        return None
    return current[-1], current, describe(item, due, now)


def describe(item, due, now):
    """(title, message) for the notification."""
    days = (due.date() - now.date()).days
    time_text = due.strftime("%H:%M")
    if days <= 0:
        when = f"today at {time_text}"
    elif days == 1:
        when = f"tomorrow at {time_text}"
    else:
        when = f"in {days} days ({due.strftime('%a')} {due.day} {due.strftime('%b')}, {time_text})"
    extra = str(item.get("course") or "").strip()  # course, or where an interview is
    if item.get("kind") == "interview":
        minutes = int((due - now).total_seconds() // 60)
        if minutes <= 90:
            when = f"in {max(minutes, 1)} min ({time_text})"
        title = f"Interview {when}"
        message = str(item.get("title") or "Interview").strip()
    else:
        title = f"Coursework due {when}"
        message = str(item.get("title") or "Coursework").strip()
    if extra:
        message += f"\n{extra}"
    return title[:63], message[:250]


def clean_items(items):
    out = []
    for raw in list(items or [])[:300]:
        if not isinstance(raw, dict):
            continue
        item = {
            "id": str(raw.get("id") or "")[:100],
            "kind": "interview" if raw.get("kind") == "interview" else "coursework",
            "title": str(raw.get("title") or "")[:200],
            "course": str(raw.get("course") or "")[:100],
            "due": str(raw.get("due") or "")[:10],
            "time": str(raw.get("time") or "")[:5],
        }
        if item["id"] and item["title"] and _due_datetime(item):
            out.append(item)
    return out


class Reminders:
    def __init__(self, folder, notify):
        self.path = os.path.join(folder, REMINDERS_FILE)
        self.notify = notify  # notify(title, message, kind)
        self.lock = threading.Lock()
        self.items = []
        self.state = {"enabled": True, "sent": {}}
        try:
            with open(self.path, encoding="utf-8-sig") as f:
                saved = json.load(f)
            if isinstance(saved, dict):
                self.state["enabled"] = bool(saved.get("enabled", True))
                if isinstance(saved.get("sent"), dict):
                    self.state["sent"] = {str(k): list(v) for k, v in saved["sent"].items() if isinstance(v, list)}
        except FileNotFoundError:
            pass
        except Exception:
            logging.exception("could not read %s", self.path)

    @property
    def enabled(self):
        return self.state["enabled"]

    def set_enabled(self, on):
        with self.lock:
            self.state["enabled"] = bool(on)
            self._save()

    def set_items(self, items):
        with self.lock:
            self.items = clean_items(items)

    def _save(self):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.state, f, indent=1)
        replace_file(tmp, self.path)

    def check(self, now=None):
        now = now or dt.datetime.now()
        to_send = []
        with self.lock:
            if not self.state["enabled"]:
                return []
            sent = self.state["sent"]
            changed = False
            for item in self.items:
                key = item_key(item)
                result = due_reminder(item, now, sent.get(key, []))
                if result:
                    stage, covered, text = result
                    sent[key] = sorted(set(sent.get(key, [])) | set(covered))
                    to_send.append((*text, item["kind"]))
                    changed = True
            # Forget reminders for deadlines that passed over a week ago.
            cutoff = (now - dt.timedelta(days=7)).date().isoformat()
            for key in [k for k in sent if k.count("|") >= 2 and k.rsplit("|", 2)[1] < cutoff]:
                del sent[key]
                changed = True
            if changed:
                try:
                    self._save()
                except Exception:
                    logging.exception("could not write %s", self.path)
        for title, message, kind in to_send:
            try:
                self.notify(title, message, kind)
                logging.info("reminder: %s - %s", title, message.splitlines()[0])
            except Exception:
                logging.exception("could not show reminder")
        return to_send

    def run(self, stopping, ready):
        ready.wait(120)  # wait until the page has sent the coursework list
        while not stopping.is_set():
            try:
                self.check()
            except Exception:
                logging.exception("reminder check failed")
            stopping.wait(30)
