"""Checks for the calendar reading: semesters found in a timetable, links file.

Run:  python -m unittest discover -s tests -v
"""

import datetime as dt
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import calendars  # noqa: E402


def timetable(*blocks):
    """A timetable .ics: for each (first Monday, weeks, skipped weeks, courses),
    a weekly Monday/Wednesday class per course, except in the skipped weeks."""
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN"]
    n = 0
    for monday, weeks, skip, courses in blocks:
        for week in range(1, weeks + 1):
            if week in skip:
                continue
            for i, course in enumerate(courses):
                for day in (0, 2):
                    start = dt.datetime.combine(monday + dt.timedelta(weeks=week - 1, days=day), dt.time(9 + i))
                    n += 1
                    lines += ["BEGIN:VEVENT", f"UID:class-{n}", f"SUMMARY:{course} - Lecture/01",
                              "DTSTART:" + start.strftime("%Y%m%dT%H%M%S"),
                              "DTEND:" + (start + dt.timedelta(hours=1)).strftime("%Y%m%dT%H%M%S"), "END:VEVENT"]
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines).encode("utf-8")


class DetectTerms(unittest.TestCase):
    def test_two_semesters_with_a_break_week(self):
        s1, s2 = dt.date(2026, 9, 21), dt.date(2027, 1, 11)
        data = timetable((s1, 11, set(), ["Computer Security", "Software Testing"]),
                         (s2, 12, {6}, ["Machine Learning", "System Design Project"]))
        terms = calendars.detect_terms(data, dt.date(2026, 10, 19))
        self.assertEqual(len(terms), 2)
        first, second = terms
        self.assertEqual((first["name"], first["start"], first["weeks"], first["breakWeeks"]),
                         ("Semester 1", "2026-09-21", 11, []))
        self.assertEqual((second["name"], second["start"], second["weeks"], second["breakWeeks"]),
                         ("Semester 2", "2027-01-11", 12, [6]))
        self.assertEqual(sorted(first["courses"]), ["Computer Security", "Software Testing"])
        self.assertEqual(sorted(second["courses"]), ["Machine Learning", "System Design Project"])

    def test_numbered_by_order_not_by_month(self):
        # An Australian-style year: Semester 1 from late February, Semester 2 from July.
        data = timetable((dt.date(2027, 2, 22), 12, set(), ["Biology"]),
                         (dt.date(2027, 7, 26), 12, set(), ["Chemistry"]))
        names = [t["name"] for t in calendars.detect_terms(data, dt.date(2027, 3, 1))]
        self.assertEqual(names, ["Semester 1", "Semester 2"])

    def test_three_terms_then_a_new_year(self):
        data = timetable((dt.date(2026, 9, 7), 14, set(), ["History"]),
                         (dt.date(2027, 1, 4), 12, set(), ["History"]),
                         (dt.date(2027, 4, 19), 8, set(), ["History"]),
                         (dt.date(2027, 9, 6), 10, set(), ["History"]))
        terms = calendars.detect_terms(data, dt.date(2027, 3, 1))
        self.assertEqual([t["number"] for t in terms], [1, 2, 3, 1])

    def test_timetable_starting_part_way_through_a_year(self):
        # Only last year's second semester, then a full year.
        data = timetable((dt.date(2026, 1, 12), 11, set(), ["Old"]),
                         (dt.date(2026, 9, 21), 11, set(), ["New"]),
                         (dt.date(2027, 1, 11), 11, set(), ["New"]))
        terms = calendars.detect_terms(data, dt.date(2026, 10, 1))
        self.assertEqual([t["number"] for t in terms], [2, 1, 2])

    def test_stray_events_are_not_a_semester(self):
        data = timetable((dt.date(2026, 9, 21), 1, set(), ["Welcome Talk"]))
        self.assertEqual(calendars.detect_terms(data, dt.date(2026, 10, 1)), [])

    def test_titles_without_a_dash(self):
        lines = ["BEGIN:VCALENDAR", "VERSION:2.0"]
        for week in range(10):
            start = dt.datetime(2026, 9, 21, 10) + dt.timedelta(weeks=week)
            lines += ["BEGIN:VEVENT", f"UID:{week}", "SUMMARY:Linear Algebra Tutorial",
                      "DTSTART:" + start.strftime("%Y%m%dT%H%M%S"),
                      "DTEND:" + (start + dt.timedelta(hours=1)).strftime("%Y%m%dT%H%M%S"), "END:VEVENT"]
        lines.append("END:VCALENDAR")
        terms = calendars.detect_terms("\r\n".join(lines).encode(), dt.date(2026, 10, 1))
        self.assertEqual(terms[0]["courses"], ["Linear Algebra"])


class LinksFile(unittest.TestCase):
    def test_write_then_read(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.path.join(folder, calendars.LINKS_FILE)
            calendars.write_links(path, {"learn": "https://example.com/learn.ics", "timetable": ""})
            self.assertEqual(calendars.read_links(path), {"learn": "https://example.com/learn.ics", "timetable": ""})


if __name__ == "__main__":
    unittest.main()
