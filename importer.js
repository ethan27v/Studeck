// =====================================================================
//  Reads a pasted course schedule (a table copied from Learn, a handbook,
//  an email...) and finds each coursework's title, release date, due date,
//  time and weight. Used by "+ Add -> Paste schedule" on the dashboard.
//
//  ScheduleImport.parse(html, text, { today, semesterStart }) -> rows
//    row = { title, release, due, time, weight, approx, text }
//    dates are "YYYY-MM-DD" ("" if not found); approx = a date came from
//    "Week 6" with no weekday, so it's a guess worth checking.
// =====================================================================
(() => {
  'use strict';

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
  const WEEKDAYS = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec)[a-z]*\\.?';
  const DOW = '(mon|tues|tue|weds|wed|thurs|thur|thu|fri|sat|sun)[a-z]*\\.?';

  const RELEASE_WORDS = /\b(releases?d?|out|set|issued|available|published|opens?|start(?:s|ed)?)\b/i;
  const DUE_WORDS = /\b(due|deadline|submi\w*|hand(?:ed)?[- ]?in|closes?|by)\b/i;
  const NOT_COURSEWORK = /\b(lectures?|tutorials?|labs?|workshops?|seminars?|readings?|office hours?)\b/i;

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

  // A date with no year belongs to whichever year puts it nearest to now
  // (a schedule covers the current academic year).
  function withYear(month, day, year, today) {
    if (year != null) {
      const y = year < 100 ? 2000 + year : year;
      const d = new Date(y, month, day);
      return d.getMonth() === month ? d : null;
    }
    let d = new Date(today.getFullYear(), month, day);
    if (d.getMonth() !== month) return null;
    const days = (d - today) / 86400000;
    if (days < -150) d = new Date(today.getFullYear() + 1, month, day);
    else if (days > 215) d = new Date(today.getFullYear() - 1, month, day);
    return d;
  }

  function weekDate(week, dow, semesterStart, role) {
    if (!semesterStart || !(week >= 1 && week <= 15)) return null;
    // Mon=0 ... Sun=6 within the teaching week; no weekday: Monday for a
    // release, Friday for a deadline (marked as approximate).
    const offset = dow != null ? (dow + 6) % 7 : role === 'release' ? 0 : 4;
    return new Date(semesterStart.getFullYear(), semesterStart.getMonth(), semesterStart.getDate() + (week - 1) * 7 + offset);
  }

  // Every date mentioned in the text, with its position.
  function findDates(text, opts) {
    const found = [];
    const add = (m, date, extra = {}) => {
      if (date && !isNaN(date)) found.push({ start: m.index, end: m.index + m[0].length, date, ...extra });
    };
    let m;
    const iso8601 = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
    while ((m = iso8601.exec(text))) add(m, withYear(+m[2] - 1, +m[3], +m[1], opts.today));

    // 23/10, 23/10/2026, 23.10.2026, 23-10-2026 (day first, UK style)
    const numeric = /\b(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{2,4}))?|[.-](\d{1,2})[.-](\d{2,4}))\b/g;
    while ((m = numeric.exec(text))) {
      const day = +m[1];
      const month = +(m[2] || m[4]) - 1;
      const year = m[3] || m[5] ? +(m[3] || m[5]) : null;
      if (month >= 0 && month < 12 && day >= 1 && day <= 31) add(m, withYear(month, day, year, opts.today));
    }

    // Fri 23rd October 2026 / 23 Oct
    const dayMonth = new RegExp(`\\b(?:${DOW},?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MON}(?:,?\\s+(\\d{4}))?\\b`, 'gi');
    while ((m = dayMonth.exec(text))) add(m, withYear(MONTHS[m[3].toLowerCase()], +m[2], m[4] ? +m[4] : null, opts.today));

    // October 23(rd)(, 2026)
    // (the day can't be the start of a time: "2 Dec 23:59" is 2 December)
    const monthDay = new RegExp(`\\b(?:${DOW},?\\s+)?${MON}\\s+(\\d{1,2})(?![:.]\\d)(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
    while ((m = monthDay.exec(text))) add(m, withYear(MONTHS[m[2].toLowerCase()], +m[3], m[4] ? +m[4] : null, opts.today));

    // Week 6 Friday / Friday of week 6 / Wk 9 / Week 6
    const week = new RegExp(`\\b(?:${DOW}\\s+(?:of\\s+)?)?(?:week|wk)\\.?\\s*(\\d{1,2})(?:\\s*,?\\s*${DOW})?\\b`, 'gi');
    while ((m = week.exec(text))) {
      const dowWord = (m[1] || m[3] || '').toLowerCase().replace(/[^a-z]/g, '');
      const dowKey = Object.keys(WEEKDAYS).find((k) => dowWord.startsWith(k));
      found.push({ start: m.index, end: m.index + m[0].length, week: +m[2], dow: dowKey ? WEEKDAYS[dowKey] : null });
    }

    // Keep the longest match where matches overlap.
    found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const out = [];
    for (const f of found) {
      const last = out[out.length - 1];
      if (last && f.start < last.end) {
        if (f.end - f.start > last.end - last.start) out[out.length - 1] = f;
        continue;
      }
      out.push(f);
    }
    return out;
  }

  // Times: 12:00, 4pm, 4.30 pm, 16.00, noon, midday, midnight
  function findTimes(text, taken) {
    const times = [];
    const re = /\b(\d{1,2})(?::|\.)(\d{2})\s*(am|pm)?\b|\b(\d{1,2})\s*(am|pm)\b|\b(noon|midday|midnight)\b/gi;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index, end = m.index + m[0].length;
      if (taken.some((t) => start < t.end && end > t.start)) continue;
      let h, min = 0;
      if (m[6]) {
        const w = m[6].toLowerCase();
        if (w === 'midnight') { h = 23; min = 59; } else h = 12;
      } else if (m[4] != null) {
        h = +m[4]; const ap = m[5].toLowerCase();
        if (h < 1 || h > 12) continue;
        if (ap === 'pm' && h !== 12) h += 12;
        if (ap === 'am' && h === 12) h = 0;
      } else {
        h = +m[1]; min = +m[2]; const ap = (m[3] || '').toLowerCase();
        if (min > 59) continue;
        if (ap) {
          if (h < 1 || h > 12) continue;
          if (ap === 'pm' && h !== 12) h += 12;
          if (ap === 'am' && h === 12) h = 0;
        } else if (h > 23) continue;
      }
      times.push({ start, end, value: `${pad(h)}:${pad(min)}` });
    }
    return times;
  }

  // Release/due role of each date from nearby words ("released ...", "due ...").
  function roleOf(text, d) {
    const before = text.slice(Math.max(0, d.start - 28), d.start);
    const rel = before.search(new RegExp(RELEASE_WORDS.source + '(?![\\s\\S]*' + DUE_WORDS.source + ')', 'i'));
    const due = before.search(new RegExp(DUE_WORDS.source + '(?![\\s\\S]*' + RELEASE_WORDS.source + ')', 'i'));
    if (due >= 0 && (rel < 0 || due > rel)) return 'due';
    if (rel >= 0) return 'release';
    // Nothing before it: look just after ("Week 3 - CW1 released").
    const after = text.slice(d.end, d.end + 30);
    const relA = after.search(RELEASE_WORDS);
    const dueA = after.search(DUE_WORDS);
    if (relA >= 0 && (dueA < 0 || relA < dueA)) return 'release';
    if (dueA >= 0) return 'due';
    return '';
  }

  function resolve(d, role, opts) {
    if (d.date) return { date: d.date, approx: false };
    const date = weekDate(d.week, d.dow, opts.semesterStart, role);
    return date ? { date, approx: d.dow == null } : null;
  }

  function weightIn(text) {
    const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(text);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return n >= 0 && n <= 100 ? n : null;
  }

  // Release + due (+ time) from free text such as
  // "CW1 released Mon 5 Oct, due Fri 23 Oct 12:00 (20%)"
  function datesFromText(text, opts, defaultRole = '') {
    const dates = findDates(text, opts);
    const times = findTimes(text, dates);
    let release = null, due = null;
    const roles = dates.map((d) => roleOf(text, d));
    dates.forEach((d, i) => {
      const role = roles[i] || defaultRole;
      if (role === 'release' && !release) release = { d, role };
      else if (role === 'due' && !due) due = { d, role };
    });
    const unlabelled = dates.filter((d, i) => !roles[i] && d !== (release && release.d) && d !== (due && due.d));
    if (!due && !defaultRole) {
      // No words to go on: one date = deadline; two = release then deadline.
      if (unlabelled.length >= 2 && !release) { release = { d: unlabelled[0], role: 'release' }; due = { d: unlabelled[unlabelled.length - 1], role: 'due' }; }
      else if (unlabelled.length) due = { d: unlabelled[unlabelled.length - 1], role: 'due' };
    }
    const r = release && resolve(release.d, 'release', opts);
    const u = due && resolve(due.d, 'due', opts);
    // The time nearest after the due date (or anywhere, if only one).
    let time = '';
    if (due) {
      const after = times.find((t) => t.start >= due.d.end && t.start - due.d.end < 25);
      const near = times.find((t) => due.d.start - t.end >= 0 && due.d.start - t.end < 6);
      time = (after || near || (times.length === 1 && !release ? times[0] : null) || {}).value || '';
    }
    return { release: r, due: u, time, spans: [...dates, ...times] };
  }

  function titleFrom(text, spans) {
    const MARK = '\u0001';
    let t = text;
    // Swap dates/times for a marker (from the end so positions stay valid)...
    [...spans].sort((a, b) => b.start - a.start).forEach((s) => { t = `${t.slice(0, s.start)} ${MARK} ${t.slice(s.end)}`; });
    t = t.replace(/\(?\s*\d{1,3}(?:\.\d+)?\s*%\s*\)?/g, ` ${MARK} `);
    // ...then drop the words that introduce them ("due Fri 23 Oct", "weight 20%"),
    // leaving words elsewhere alone ("Report on testing").
    const lead = /\b(released?|issued|available|published|opens?|out|set|due(?: date)?|deadline|submission(?: deadline)?|hand(?:ed)?[- ]?in|closes?|at|on|by|from|before|weight(?:ing)?|worth)\b[\s:,-]*\u0001/gi;
    for (let i = 0; i < 4 && lead.test(t); i++) t = t.replace(lead, MARK);
    t = t
      .split(MARK).join(' ')
      .replace(/\(\s*\)/g, ' ')
      .replace(/\b(released?|out|set|due|deadline)\s*$/i, ' ') // "CW1 released"
      .replace(/\s*[|]\s*/g, ' · ')
      .replace(/(\s*[·/,;–—-]\s*)+(?=\s*[·/,;–—-])/g, '') // runs of separators
      .replace(/^[\s\-–—•*:|·/,.;]+|[\s\-–—•*:|·/,.;(]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    return t.slice(0, 200);
  }

  // ---------- tables ----------
  const HEADERS = {
    title: /^(title|name|assessment|assignment|coursework|task|item|deliverable|description|what|component)/i,
    release: /(release|issued|set\b|out\b|available|start|published|opens)/i,
    due: /(due|deadline|submission|submit|hand[- ]?in|closes)/i,
    weight: /(weight|%|worth|percent|contribution|value)/i,
    time: /^time$/i,
    date: /^dates?$/i,
  };

  function headerMap(cells, opts) {
    if (cells.some((c) => findDates(c, opts).length)) return null;
    const map = {};
    cells.forEach((c, i) => {
      const t = clean(c);
      if (!t || t.length > 40) return;
      for (const key of ['due', 'release', 'weight', 'time', 'date', 'title']) {
        if (map[key] == null && HEADERS[key].test(t)) { map[key] = i; break; }
      }
    });
    const hits = Object.keys(map).length;
    return hits >= 2 && (map.due != null || map.release != null || map.date != null) ? map : null;
  }

  function rowFromCells(cells, map, opts) {
    const joined = cells.map(clean).filter(Boolean).join(' | ');
    if (!map) {
      const row = rowFromText(joined, opts);
      if (cells.length > 1) {
        // Title = the first cell that still has words once its dates are removed
        // (only its first line: later lines are details like "Worth: 20%").
        const titles = cells.map((c) => titleFrom(firstLine(c), datesFromText(firstLine(c), opts).spans));
        row.title = titles.find((t) => /[a-z]{2}/i.test(t)) || row.title;
      }
      return row;
    }
    const cell = (k) => (map[k] != null ? clean(cells[map[k]]) : '');
    const dueCell = cell('due') || cell('date');
    const dueInfo = dueCell ? datesFromText(dueCell + (cell('time') ? ' ' + cell('time') : ''), opts, 'due') : null;
    const relInfo = cell('release') ? datesFromText(cell('release'), opts, 'release') : null;
    let title = map.title != null ? firstLine(cells[map.title]) : '';
    if (!title) {
      // First cell that is mostly words (its first line).
      const used = new Set(Object.values(map));
      title = cells.map(firstLine).find((c, i) => !used.has(i) && /[a-z]{3}/i.test(c) && !findDates(c, opts).length) || '';
    }
    const due = dueInfo && (dueInfo.due || dueInfo.release);
    const release = relInfo && (relInfo.release || relInfo.due);
    return {
      title: clean(title).slice(0, 200),
      release: release ? iso(release.date) : '',
      due: due ? iso(due.date) : '',
      time: dueInfo ? dueInfo.time : '',
      weight: weightIn(cell('weight')) ?? weightIn(joined),
      approx: !!((due && due.approx) || (release && release.approx)),
      text: joined,
    };
  }

  function rowFromText(text, opts) {
    const info = datesFromText(text, opts);
    return {
      title: titleFrom(text, info.spans),
      release: info.release ? iso(info.release.date) : '',
      due: info.due ? iso(info.due.date) : '',
      time: info.time,
      weight: weightIn(text),
      approx: !!((info.due && info.due.approx) || (info.release && info.release.approx)),
      text,
    };
  }

  // Text of a table cell, keeping its separate lines apart ("Network exploits" /
  // "Worth: 0%" / "Effort: 10 Hours" would otherwise run together).
  const BLOCK = /^(P|DIV|BR|LI|UL|OL|H[1-6]|TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|BLOCKQUOTE|PRE|DT|DD|DL|HR)$/;
  function cellText(node) {
    let out = '';
    const walk = (n) => {
      for (const child of n.childNodes) {
        if (child.nodeType === 3) out += child.nodeValue;
        else if (child.nodeType === 1) {
          const block = BLOCK.test(child.nodeName);
          if (block) out += '\n';
          walk(child);
          if (block) out += '\n';
        }
      }
    };
    walk(node);
    return out.split('\n').map(clean).filter(Boolean).join('\n');
  }
  const firstLine = (cell) => String(cell || '').split('\n').map(clean).find(Boolean) || '';

  function tablesFromHtml(html) {
    if (!html || !/<t[dh][\s>]/i.test(html)) return [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return [...doc.querySelectorAll('table')]
      .map((table) => [...table.querySelectorAll('tr')]
        .map((tr) => [...tr.querySelectorAll('th,td')].map(cellText)))
      .filter((rows) => rows.length);
  }

  function parse(html, text, options = {}) {
    const opts = { today: options.today || new Date(), semesterStart: options.semesterStart || null };
    let tables = tablesFromHtml(html);
    if (!tables.length) {
      // Plain text: tab-separated lines are table rows; anything else is one line per item.
      const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => clean(l));
      tables = [lines.map((l) => (l.includes('\t') ? l.split('\t') : [l]))];
    }
    const rows = [];
    for (const table of tables) {
      let map = null;
      for (const cells of table) {
        if (!cells.some((c) => clean(c))) continue;
        const header = headerMap(cells, opts);
        if (header) { map = header; continue; }
        const row = rowFromCells(cells, cells.length > 1 ? map : null, opts);
        if (!row.due && !row.release) continue; // no dates: not a schedule entry
        if (!row.title) row.title = 'Coursework';
        rows.push(row);
      }
    }
    // "CW1 released (week 3)" + "CW1 due (week 5)" on separate lines -> one item.
    const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const merged = [];
    for (const row of rows) {
      const twin = merged.find((m) => key(m.title) === key(row.title)
        && ((m.release && !m.due && row.due && !row.release) || (m.due && !m.release && row.release && !row.due)));
      if (twin) {
        if (!twin.due) Object.assign(twin, { due: row.due, time: row.time });
        if (!twin.release) twin.release = row.release;
        twin.weight = twin.weight ?? row.weight;
        twin.approx = twin.approx || row.approx;
        twin.text += ' / ' + row.text;
      } else merged.push(row);
    }
    for (const row of merged) {
      row.likely = !!row.due && !(NOT_COURSEWORK.test(row.title) && !DUE_WORDS.test(row.text));
    }
    return merged;
  }

  // Rows from a module's .ics calendar (events already read by the desktop app):
  // "CW1 released" + "CW1 due" become one item, classes (lectures, repeating
  // hour-long sessions) are left out, and past deadlines start unticked.
  // Returns { rows, classes } - classes is how many class events were skipped.
  const ROLE_PREFIX = /^\s*((submission\s+)?deadline|due(\s+date)?|submission|hand[- ]?in|release[ds]?|opens?|available|out)\s*(for|of)?\s*[:\-–—]\s*/i;
  const ROLE_SUFFIX = /[\s:\-–—(]*\b((submission\s+)?(deadline|due(\s+date)?)|submission|hand[- ]?in|release[ds]?|opens?|available|out(\s+now)?|is\s+due)\)?\s*$/i;
  function fromEvents(events, options = {}) {
    const todayIso = iso(options.today || new Date());
    const key = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const bare = (summary) => {
      let t = summary
        .replace(/^[A-Za-z]{2,}[-\s]?\d{0,4}[-\s]+(?=(cw|hw|a|asg)\d)/i, '') // "CSEC-10-CW1 ..." -> "CW1 ..."
        .replace(/(\S.*?)\s+\1(?=\s|$)/i, '$1'); // "Network exploits Network exploits"
      for (let i = 0; i < 3; i++) t = t.replace(ROLE_PREFIX, '').replace(ROLE_SUFFIX, '');
      return titleFrom(t, []) || titleFrom(summary, []) || 'Coursework';
    };
    const list = (events || []).filter((ev) => ev && clean(ev.summary) && /^\d{4}-\d\d-\d\d$/.test(ev.date || ''));
    // A class: an hour-ish timed event with no deadline wording that's a
    // lecture/tutorial/... or repeats three or more times.
    const repeats = {};
    list.forEach((ev) => { const k = key(clean(ev.summary)); repeats[k] = (repeats[k] || 0) + 1; });
    const isClass = (ev) => {
      const summary = clean(ev.summary);
      if (ev.allDay || !(ev.minutes >= 30)) return false;
      if (DUE_WORDS.test(summary) || /\b(release[ds]?|coursework|assignment|assessment|cw\d*)\b/i.test(summary)) return false;
      return NOT_COURSEWORK.test(summary) || repeats[key(summary)] >= 3;
    };
    const rows = [];
    let classes = 0;
    for (const ev of list) {
      if (isClass(ev)) { classes++; continue; }
      const summary = clean(ev.summary);
      const text = clean([summary, ev.desc].filter(Boolean).join(' | '));
      // (Stricter than RELEASE_WORDS: "Problem Set 3" on its own is a deadline.)
      const isRelease = /\b(release[ds]?|issued|available|published|opens?|out|starts?)\b/i.test(summary) && !DUE_WORDS.test(summary);
      const title = bare(summary);
      // One long event from release to deadline (how Learn/Gradescope often export).
      const span = ev.endDate && ev.endDate > ev.date
        && (ev.allDay || ev.minutes >= 36 * 60);
      const midnightDay = !ev.allDay && ev.time === '00:00' && ev.minutes === 1440;
      const row = span
        ? { title, release: ev.date, due: ev.endDate, time: ev.allDay ? '' : ev.endTime || '' }
        : { title, release: isRelease ? ev.date : '', due: isRelease ? '' : ev.date,
            time: isRelease || midnightDay ? '' : ev.time || '' };
      Object.assign(row, { weight: weightIn(text), approx: false, text });
      if (rows.some((r) => key(r.title) === key(row.title)
        && (row.due ? r.due === row.due : r.release === row.release))) continue; // listed twice
      const twin = rows.find((r) => key(r.title) === key(row.title)
        && ((r.release && !r.due && row.due) || (r.due && !r.release && row.release)));
      if (twin) {
        if (!twin.due) Object.assign(twin, { due: row.due, time: row.time });
        if (!twin.release) twin.release = row.release;
        twin.weight = twin.weight ?? row.weight;
        twin.text += ' / ' + row.text;
      } else rows.push(row);
    }
    for (const row of rows) {
      row.past = !!row.due && row.due < todayIso;
      row.likely = !!row.due && !row.past && !(NOT_COURSEWORK.test(row.title) && !DUE_WORDS.test(row.text))
        && !/\b(feedback|marks?|results?|grades?|holidays?|vacation|reading week|break|exam period)\b/i.test(row.title);
    }
    return { rows, classes };
  }

  window.ScheduleImport = { parse, fromEvents, findDates, findTimes };
})();
