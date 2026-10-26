(() => {
  'use strict';

  const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const PALETTE = ['coral', 'amber', 'mint', 'sky', 'violet', 'rose', 'lime', 'slate'];
  const STORE_KEY = 'student-dashboard-state';
  const SOON_DAYS = 14; // "Due soon" looks two weeks ahead
  const PASTE_HINT = /Mac/.test(navigator.platform || navigator.userAgent)
    ? 'Copy a schedule (⌘C), click the box below and press ⌘V.'
    : 'Copy a schedule (Ctrl+C), click the box below and press Ctrl+V.';

  const ICONS = {
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 13h18"/>',
    list: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
    timer: '<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.6 1.6M9.5 2.8h5"/>',
    bars: '<path d="M5 20V12M10 20V6M15 20v-9M20 20V9"/>',
  };
  const TICK = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 6.2l2.3 2.3 4.7-4.9"/></svg>';

  const params = new URLSearchParams(location.search);
  const body = document.body;
  const grid = document.getElementById('grid');
  const panel = document.getElementById('panel');
  // The daily "Today at a glance" pop-up (summary.html) uses this same file.
  const SUMMARY = window.DASHBOARD_MODE === 'summary';
  const els = {
    overview: document.getElementById('overview'),
    schedule: document.getElementById('schedule'),
    due: document.getElementById('due'),
    coursework: document.getElementById('coursework'),
    week: document.getElementById('week'),
    media: document.getElementById('media'),
  };

  let data = null;      // what the dashboard shows: your data file + your settings + the timetable
  let baseData = null;  // data.js / my-data.js as written
  let settings = {};    // from the setup / settings window (state.json "settings")
  let feeds = null; // { learn: {...}, timetable: {...} } from the desktop app
  let dataError = '';
  let appMode = false;
  // Ticks made on the dashboard: { done: {taskId: bool}, submitted: {cwId: bool} }
  let saved = { done: {}, submitted: {}, courseOf: {}, coursework: [], cwMeta: {}, plans: [], view: 'uni' };
  let pickingFor = null; // id of the Learn deadline whose course picker is open
  // Items ticked since the panel opened stay visible (struck through) until it next opens.
  const recentlyTicked = new Set();
  let lastMinute = '';

  // ---------- helpers ----------
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function parseDate(s) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s ?? '').trim());
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return d.getMonth() === +m[2] - 1 ? d : null; // rejects e.g. 2026-02-31
  }
  function toMin(t) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(t ?? '').trim());
    if (!m || +m[1] > 24 || +m[2] > 59) return null;
    return +m[1] * 60 + +m[2];
  }
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  // Whole calendar days from a to b (DST-safe thanks to rounding).
  const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const shortDate = (d) => `${DAY_KEYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const normDay = (s) => {
    const k = String(s ?? '').trim().slice(0, 3).toLowerCase();
    return DAY_KEYS.find((d) => d.toLowerCase() === k) || '';
  };
  function fmtDur(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  function fmtHours(min) {
    const h = Math.round((min / 60) * 10) / 10;
    return `${h}h`;
  }
  function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }

  // ?date=YYYY-MM-DD&time=HH:MM lets you preview another day.
  function now() {
    const real = new Date();
    const d = parseDate(params.get('date'));
    const t = toMin(params.get('time'));
    if (!d && t == null) return real;
    const base = d || real;
    const mins = t != null ? t : real.getHours() * 60 + real.getMinutes();
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.floor(mins / 60), mins % 60);
  }

  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  }
  // shortTitle (optional) is shown instead of title when the card is narrow.
  function head(iconName, title, meta, status, actionHtml = '', shortTitle = '') {
    const dot = status ? `<span class="sync ${status.cls}" title="${esc(status.tip)}"></span>` : '';
    const metaHtml = `<span class="card-meta" title="${esc(meta || '')}">${esc(meta || '')}</span>`;
    const titleHtml = shortTitle
      ? `<span class="t-long">${esc(title)}</span><span class="t-short">${esc(shortTitle)}</span>`
      : esc(title);
    return `<header class="card-head">${icon(iconName)}<h2 class="card-title" title="${esc(title)}">${titleHtml}</h2>${dot}${metaHtml}${actionHtml}</header>`;
  }
  function fmtSynced(stamp) {
    const d = new Date(String(stamp));
    if (isNaN(d)) return '';
    const days = daysBetween(d, now());
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return days === 0 ? `at ${time}` : days === 1 ? `yesterday at ${time}` : `on ${shortDate(d)}`;
  }
  // Green = synced, amber = showing saved data, red = not working. Hover for details.
  function feedStatus(kind, label) {
    const f = feedOn(kind);
    if (!f) return null;
    if (f.ok) return { cls: 'ok', tip: `${label} synced ${fmtSynced(f.updated)}` };
    if (f.updated) {
      const why = f.error || 'refreshing';
      return { cls: 'stale', tip: `${label}: ${why}${/[.?!]$/.test(why) ? '' : '.'} Showing what was synced ${fmtSynced(f.updated)}.` };
    }
    return { cls: f.error ? 'error' : 'stale', tip: `${label}: ${f.error || 'connecting'}` };
  }
  function feedProblem(kind, label) {
    const f = feedOn(kind);
    return f && !f.updated && f.error ? `<div class="note warn" title="${esc(f.error)}"><b>${esc(label)}:</b> ${esc(f.error)}</div>` : '';
  }

  // ---------- data access ----------
  const list = (key) => (Array.isArray(data[key]) ? data[key] : []);
  let moduleMap = new Map();
  const setUp = () => !!(settings && settings.setupDone);
  // What your VLE is called ("Learn", "Moodle", "Canvas"...), for labels.
  const dlName = () => String((settings && settings.deadlinesName) || (data && data.deadlinesName) || 'your uni site');
  // What your uni calls its teaching blocks: Semester, Term, Trimester or Quarter.
  const termWord = () => (settings && ['Semester', 'Term', 'Trimester', 'Quarter'].includes(settings.termWord) ? settings.termWord : 'Semester');

  // The data the dashboard works from: your data file, with the settings from
  // the setup window on top (once you've been through it), and modules filled
  // in from your timetable.
  function rebuildData() {
    if (!baseData) { data = null; return; }
    const d = { ...baseData };
    const s = settings || {};
    if (setUp()) {
      d.sample = false;
      if (baseData.sample) { d.tasks = []; d.coursework = []; d.schedule = []; d.modules = []; }
      if (s.name != null) d.name = s.name;
      if (s.theme) d.theme = s.theme;
      if (s.study) d.study = { ...(baseData.study || {}), ...s.study };
    }
    d.modules = buildModules(d);
    // Weekly classes typed in on the Classes page of Settings (by course name).
    if (setUp() && Array.isArray(s.classes) && s.classes.length) {
      const codeOf = (name) => {
        const m = name ? d.modules.find((x) => sameCourse(x, String(name))) : null;
        return m ? m.code : '';
      };
      d.schedule = (Array.isArray(d.schedule) ? d.schedule : []).concat(s.classes.map((c) => {
        const code = codeOf(c.module);
        return { day: c.day, start: c.start, end: c.end, title: code ? '' : c.module || 'Class', type: c.type, module: code, room: c.room };
      }));
    }
    data = d;
  }

  // ---------- semesters ----------
  // Where the semesters come from, in order: dates you entered in Settings, the
  // timetable (blocks of teaching weeks, worked out by the app), the "semester"
  // in your data file.
  function termList() {
    const s = (settings && settings.semesters) || {};
    const toTerm = (t) => {
      const start = parseDate(t.start);
      if (!start) return null;
      const weeks = Math.max(1, parseInt(t.weeks ?? t.teachingWeeks, 10) || 11);
      return {
        name: t.number ? `${termWord()} ${t.number}` : t.name || termWord(), start, weeks,
        breakWeeks: Array.isArray(t.breakWeeks) ? t.breakWeeks.map(Number) : [],
        courses: Array.isArray(t.courses) ? t.courses : [],
      };
    };
    if (setUp() && s.mode === 'manual' && Array.isArray(s.terms) && s.terms.length) return s.terms.map(toTerm).filter(Boolean);
    const auto = feeds && feeds.timetable && Array.isArray(feeds.timetable.terms) ? feeds.timetable.terms : [];
    if (auto.length) return auto.map(toTerm).filter(Boolean);
    const sem = data && data.semester;
    return sem && parseDate(sem.start) ? [toTerm(sem)].filter(Boolean) : [];
  }
  // The semester that matters on a day: the one you're in; between semesters,
  // the next one (with the one that just ended as prev); after the last, that one.
  function pickTerm(day) {
    const terms = termList().sort((a, b) => a.start - b.start);
    const endOf = (t) => addDays(t.start, t.weeks * 7);
    const current = terms.find((t) => t.start <= day && day < endOf(t));
    const next = terms.find((t) => t.start > day);
    const prev = [...terms].reverse().find((t) => endOf(t) <= day);
    return { term: current || next || prev || null, current, next, prev };
  }
  // The semester's courses (this semester; between semesters, the next one).
  function termCourses(day) {
    const { term } = pickTerm(day);
    return term ? term.courses.map(cleanCourseName) : [];
  }

  // ---------- modules ----------
  const cleanCourseName = (c) => String(c ?? '').replace(/\s*[([].*$/, '').trim();
  const STOP_WORDS = new Set(['and', 'of', 'to', 'the', 'in', 'for', 'a', 'an', 'with', 'on', '&']);
  function abbrev(name) {
    const words = String(name).split(/[\s-]+/).filter((w) => w && !STOP_WORDS.has(w.toLowerCase()));
    if (words.length === 1) return words[0].replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'MOD';
    return words.map((w) => (/^\d/.test(w) ? w : w[0])).join('').replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toUpperCase() || 'MOD';
  }
  // A colour that stays the same for a course from one semester to the next.
  function colourFor(name, taken) {
    let h = 0;
    for (const ch of String(name).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    for (let i = 0; i < PALETTE.length; i++) {
      const c = PALETTE[(h + i) % PALETTE.length];
      if (!taken.has(c)) return c;
    }
    return PALETTE[h % PALETTE.length];
  }
  const sameCourse = (m, name) => {
    const n = name.toLowerCase();
    return String(m.name || '').toLowerCase() === n || cleanCourseName(m.name).toLowerCase() === n
      || (Array.isArray(m.match) && m.match.some((w) => cleanCourseName(w).toLowerCase() === n));
  };
  // Your modules: the ones in your data file, then every course in your timetable
  // (all semesters it covers), with the codes, colours and hidden courses you set
  // in Settings on top, plus courses you added there yourself.
  function buildModules(d) {
    const out = (Array.isArray(d.modules) ? d.modules : []).map((m) => ({ ...m }));
    const seen = new Set();
    const courses = [];
    const recent = (t) => addDays(t.start, t.weeks * 7 + 120) >= startOfDay(new Date()); // not long finished
    for (const t of termList().filter(recent)) {
      for (const c of t.courses) {
        const name = cleanCourseName(c);
        if (name && !seen.has(name.toLowerCase())) { seen.add(name.toLowerCase()); courses.push({ name, raw: c }); }
      }
    }
    const codes = new Set(out.map((m) => String(m.code ?? '').toLowerCase()));
    const unique = (code) => {
      let c = code, i = 2;
      while (codes.has(c.toLowerCase())) c = `${code}${i++}`;
      codes.add(c.toLowerCase());
      return c;
    };
    for (const { name, raw } of courses) {
      if (out.some((m) => sameCourse(m, name))) continue;
      out.push({ code: unique(abbrev(name)), name, color: '', match: raw !== name ? [raw] : [], auto: true });
    }
    for (const c of (settings && Array.isArray(settings.modules) ? settings.modules : [])) {
      if (!c || !c.name) continue;
      let m = out.find((x) => sameCourse(x, c.name));
      if (!m && c.manual) { m = { code: unique(c.code || abbrev(c.name)), name: c.name, manual: true }; out.push(m); }
      if (!m) continue;
      if (c.code && c.code !== m.code && !codes.has(c.code.toLowerCase())) { codes.add(c.code.toLowerCase()); m.code = c.code; }
      if (c.color) m.color = c.color;
      m.hidden = !!c.hidden;
      if (Array.isArray(c.match)) m.match = [...(m.match || []), ...c.match];
    }
    const taken = new Set(out.map((m) => m.color).filter(Boolean));
    for (const m of out) {
      if (!m.color) { m.color = colourFor(m.name || m.code, taken); taken.add(m.color); }
    }
    return out;
  }
  // The modules you're taking now (this semester's courses, when the timetable says).
  function currentModules(day) {
    const mods = list('modules').filter((m) => !m.hidden);
    const names = termCourses(day).map((n) => n.toLowerCase());
    if (!names.length) return mods;
    const now = mods.filter((m) => names.some((n) => sameCourse(m, n)));
    return now.length ? now : mods;
  }

  function moduleColor(code) {
    const mod = moduleMap.get(String(code ?? '').toLowerCase());
    const c = mod && String(mod.color ?? '').trim().toLowerCase();
    if (c && PALETTE.includes(c)) return `var(--c-${c})`;
    if (c && /^#[0-9a-f]{3,8}$/.test(c)) return c;
    return 'var(--c-slate)';
  }
  function moduleName(code) {
    const mod = moduleMap.get(String(code ?? '').toLowerCase());
    return mod && mod.name ? mod.name : String(code ?? '');
  }
  function moduleCode(code) {
    const mod = moduleMap.get(String(code ?? '').toLowerCase());
    return mod ? String(mod.code) : String(code ?? '');
  }

  function semesterInfo(day) {
    const { term, current, next, prev } = pickTerm(day);
    if (!term) return null;
    const elapsed = daysBetween(term.start, day);
    return {
      name: term.name, start: term.start, weeks: term.weeks, elapsed,
      week: Math.floor(elapsed / 7) + 1,
      breakWeeks: term.breakWeeks,
      inTerm: !!current, between: !current && !!next && !!prev, next, prev,
    };
  }

  // Recurring classes only run during teaching weeks (if a semester is set).
  function classesRunOn(day) {
    const s = semesterInfo(day);
    if (!s) return true;
    if (s.elapsed < 0 || s.week > s.weeks) return false;
    return !s.breakWeeks.includes(s.week);
  }

  // ---------- calendar feeds (Learn + uni timetable, desktop app only) ----------
  const feedOn = (kind) => (feeds && feeds[kind] && feeds[kind].configured ? feeds[kind] : null);
  // A feed counts as connected once it has loaded at least once (it may be showing cached data).
  const feedLive = (kind) => { const f = feedOn(kind); return !!(f && f.updated); };
  const feedEvents = () => [
    ...(feedLive('timetable') ? feeds.timetable.events || [] : []).map((e) => ({ ...e, source: 'timetable' })),
    ...(feedLive('learn') ? feeds.learn.events || [] : []).map((e) => ({ ...e, source: 'learn' })),
  ];

  const escapeRe = (str) => str.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  // Works out which of your modules a calendar item belongs to (for its colour).
  // Tries each text in order (title first, then course/description).
  function matchModule(...texts) {
    for (const t of texts) {
      const code = matchModuleIn(t);
      if (code) return code;
    }
    return '';
  }
  function matchModuleIn(text) {
    const hay = String(text ?? '').toLowerCase();
    if (!hay) return '';
    const mods = list('modules');
    const hasWord = (word) => {
      const w = String(word ?? '').trim().toLowerCase();
      return !!w && new RegExp('(^|[^a-z0-9])' + escapeRe(w) + '([^a-z0-9]|$)').test(hay);
    };
    // Full names and "match" words first; short codes like "ST" only as a fallback.
    for (const m of mods) {
      const name = String(m.name ?? '').trim().toLowerCase();
      const extra = Array.isArray(m.match) ? m.match : m.match ? [m.match] : [];
      if ((name.length >= 4 && hay.includes(name)) || extra.some(hasWord)) return String(m.code);
    }
    for (const m of mods) if (hasWord(m.code)) return String(m.code);
    return '';
  }
  // "INFR11130 Machine Learning Practical - Lecture" -> "Machine Learning Practical - Lecture"
  const cleanTitle = (t) => String(t ?? '').replace(/^[A-Z]{4}\d{5}\s*[-:–]?\s*/, '').trim() || String(t ?? '');
  // "Machine Learning Practical (2026-2027)[SEM1]" -> "Machine Learning Practical"
  const cleanCourse = (c) => String(c ?? '').replace(/\s*[([].*$/, '').trim();
  const normTitle = (t) => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Colour group for a class type (Lecture, Tutorial, Workshop...).
  function kindClass(kind) {
    const k = String(kind ?? '').toLowerCase();
    if (/exam/.test(k)) return 'exam';
    if (/interview/.test(k)) return 'interview';
    if (/tutorial|recital|seminar/.test(k)) return 'tutorial';
    if (/workshop|lab|practical/.test(k)) return 'workshop';
    if (/lecture/.test(k)) return 'lecture';
    return 'other';
  }
  function kindHtml(e) {
    if (!e.type) return '';
    return `<span class="kind k-${kindClass(e.type)}">${esc(e.type)}</span>${e.group ? ` · Group ${esc(e.group)}` : ''}`;
  }

  // Course name for a deadline. Learn deadlines get a "Which course?" picker,
  // because Learn's calendar link doesn't say which course they belong to.
  function courseLabelHtml(item) {
    if (item.pickable && pickingFor === item.id) {
      const chips = list('modules').map((m) => `<button class="pick-chip" type="button" data-pick-for="${esc(item.id)}" data-code="${esc(m.code)}" style="--c:${moduleColor(m.code)}" title="${esc(m.name)}">${esc(m.code)}</button>`).join('');
      return `<span class="picker">${chips}<button class="pick-chip cancel" type="button" data-pick-cancel title="Cancel" aria-label="Cancel">✕</button></span>`;
    }
    const name = item.module ? moduleName(item.module) : cleanCourse(item.course);
    if (item.pickable) {
      return `<button class="pick${name ? ' set' : ''}" type="button" data-pick="${esc(item.id)}" title="${name ? 'Change course' : 'Pick which course this is for'}">${esc(name || 'Which course?')}</button>`;
    }
    return esc(name);
  }
  function subLine(item, rest) {
    const label = courseLabelHtml(item);
    const extra = item.pickable && pickingFor === item.id ? '' : rest.filter(Boolean).map(esc).join(' · ');
    return `<span class="dot"></span>${label}${label && extra ? ' · ' : ''}${extra}`;
  }

  // ---------- plans (interviews etc. - the Life view) ----------
  const PLAN_TYPES = {
    interview: { label: 'Interview', color: 'var(--c-amber)' },
    plan: { label: 'Plan', color: 'var(--c-rose)' },
    deadline: { label: 'Deadline', color: 'var(--c-lime)' },
    other: { label: 'Other', color: 'var(--c-slate)' },
  };
  const planType = (p) => PLAN_TYPES[p.type] || PLAN_TYPES.plan;
  const isLink = (w) => /^https?:\/\/\S+$/i.test(String(w || '').trim());

  function allPlans() {
    return (saved.plans || [])
      .map((p) => ({ ...p, dateD: parseDate(p.date), s: toMin(p.start), e: toMin(p.end) }))
      .filter((p) => p.dateD)
      .sort((a, b) => a.dateD - b.dateD || (a.s ?? -1) - (b.s ?? -1) || String(a.title).localeCompare(String(b.title)));
  }
  // A plan shaped like a timetable event, so the schedule and week views can show it.
  function planAsEvent(p) {
    return {
      start: p.start, end: p.end, title: p.title, type: planType(p).label,
      room: isLink(p.where) ? 'Online' : p.where, link: isLink(p.where) ? p.where.trim() : '',
      source: 'plan', planId: p.id, planKind: p.type, color: planType(p).color, notes: p.notes,
    };
  }
  const plansOn = (day) => allPlans().filter((p) => daysBetween(p.dateD, day) === 0);

  function allDayOn(day) {
    const dIso = iso(day);
    return feedEvents().filter((e) => e.allDay && e.date <= dIso && dIso <= (e.endDate || e.date))
      .concat(plansOn(day).filter((p) => p.s == null).map((p) => ({ ...planAsEvent(p), allDay: true })));
  }

  function eventsOn(day) {
    const key = DAY_KEYS[day.getDay()];
    const dIso = iso(day);
    const recurring = classesRunOn(day);
    const timetableFeed = feedLive('timetable');
    const fromFeeds = feedEvents()
      .filter((e) => !e.allDay && e.date === dIso)
      .map((e) => {
        const module = matchModule(e.title, e.course, e.desc);
        return {
          start: e.start, end: e.end, room: e.room, source: e.source, module,
          // "Software Testing - Tutorial/04" -> title "Software Testing", type "Tutorial", group "04"
          title: module ? moduleName(module) : e.course || cleanTitle(e.title),
          type: e.source === 'learn' ? dlName() : e.kind || '',
          group: e.group || '', staff: e.staff || '',
        };
      });
    return list('schedule')
      .filter((e) => {
        if (e.date) { const d = parseDate(e.date); return !!d && iso(d) === dIso; }
        // Once your uni timetable is connected it replaces the weekly timetable in data.js.
        return !timetableFeed && recurring && normDay(e.day) === key;
      })
      .concat(fromFeeds)
      .concat(plansOn(day).filter((p) => p.s != null).map(planAsEvent))
      .map((e) => ({ ...e, s: toMin(e.start), e: toMin(e.end) }))
      .filter((e) => e.s != null)
      .map((e) => ({ ...e, e: e.e != null && e.e > e.s ? e.e : e.s + 60 }))
      .sort((a, b) => a.s - b.s || a.e - b.e);
  }

  const taskId = (t, i) => String(t.id ?? `task-${i}-${t.title}`);
  const cwId = (c, i) => String(c.id ?? `cw-${i}-${c.title}`);

  function allTasks() {
    return list('tasks').map((t, i) => {
      const id = taskId(t, i);
      const done = id in saved.done ? !!saved.done[id] : !!t.done;
      return { ...t, id, dueD: parseDate(t.due), done };
    });
  }
  const knownModule = (code) => (code && moduleMap.has(String(code).toLowerCase()) ? String(code) : '');
  const clampPct = (v) => {
    if (v === '' || v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  };

  // source: 'file' = data.js, 'mine' = added on the dashboard, 'learn' = Learn calendar
  function allCoursework() {
    const learn = feedLive('learn');
    // Sample coursework is hidden once real Learn deadlines are coming in.
    const local = learn && data.sample ? [] : list('coursework');
    const fileItems = local.map((c, i) => {
      const id = cwId(c, i);
      const submitted = id in saved.submitted ? !!saved.submitted[id] : !!c.submitted;
      return { ...c, id, dueD: parseDate(c.due), submitted, progress: clampPct(c.progress) ?? 0, source: 'file' };
    });
    const mine = (saved.coursework || []).map((c) => ({
      ...c, dueD: parseDate(c.due), submitted: !!saved.submitted[c.id],
      weight: Number(c.weight) || 0, progress: clampPct(c.progress) ?? 0, source: 'mine',
    }));
    const items = [...fileItems, ...mine];

    if (learn) {
      const fileByTitle = new Map(fileItems.map((c) => [normTitle(c.title), c]));
      const mineTitles = new Set(mine.map((c) => normTitle(c.title)));
      for (const d of feeds.learn.deadlines || []) {
        const key = normTitle(d.title);
        if (mineTitles.has(key)) continue; // you added it yourself: your version wins
        const fromFile = fileByTitle.get(key);
        if (fromFile) {
          // Same title in data.js: Learn's date wins, your weight/progress stay.
          Object.assign(fromFile, { dueD: parseDate(d.date), time: d.time, course: d.course });
          continue;
        }
        const id = `learn:${d.id}`;
        // Learn's link doesn't say which course a deadline is for: use the one you
        // picked on the dashboard, or a course named in the title.
        items.push({
          id, title: d.title, time: d.time, dueD: parseDate(d.date), submitted: !!saved.submitted[id],
          course: d.course, source: 'learn', weight: 0, progress: null,
          module: knownModule(saved.courseOf[id]) || matchModule(d.title, d.course, d.desc),
          pickable: true,
        });
      }
    }

    // Course / weight / progress / link you set on the dashboard for Learn and data.js items.
    for (const c of items) {
      const meta = c.source !== 'mine' && saved.cwMeta[c.id];
      if (meta) {
        if (knownModule(meta.module)) c.module = meta.module;
        if (meta.weight != null) c.weight = meta.weight;
        if (meta.progress != null) c.progress = clampPct(meta.progress);
        if (meta.link) c.link = meta.link;
        if (meta.release) c.release = meta.release;
      }
      if (c.submitted && c.progress != null) c.progress = 100;
    }
    return items;
  }
  const byDue = (a, b) => (a.dueD ? a.dueD.getTime() : Infinity) - (b.dueD ? b.dueD.getTime() : Infinity)
    || (toMin(a.time) ?? 1e4) - (toMin(b.time) ?? 1e4)
    || String(a.title).localeCompare(String(b.title));

  // "Tuesday 20 October", or "Tue 20 Oct" when the overview card is narrow.
  function dateHtml(today) {
    return `<span class="dl">${DAY_LONG[today.getDay()]}</span><span class="ds">${DAY_KEYS[today.getDay()]}</span> <span class="dm">${today.getDate()}<span class="mo"> <span class="dl">${MONTHS_LONG[today.getMonth()]}</span><span class="ds">${MONTHS[today.getMonth()]}</span></span></span>`;
  }
  // Shorten the date until it fits beside the Uni/Life/Study switch:
  // "Monday 19 October", "Mon 19 Oct", the same a bit smaller, then "Mon 19",
  // and last of all a tighter switch.
  function fitDate() {
    document.querySelectorAll('.date-row .date').forEach((el) => {
      for (let i = 0; i <= 4; i++) {
        el.className = i ? `date f${Math.min(i, 3)}` : 'date';
        el.parentElement.classList.toggle('tight', i === 4);
        if (el.scrollWidth <= el.clientWidth) break;
      }
    });
  }
  window.addEventListener('resize', () => fitDate());

  const GEAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
  const gearButton = () => (apiReady() ? `<button type="button" class="gear" data-open-settings title="Settings">${GEAR}</button>` : '');

  // ---------- Uni / Life / Study switch ----------
  // The Life button shows how many plans are coming up this week, highlighted
  // when an interview is within two days. Study shows the focus timer's time
  // left, or bouncing bars while music plays.
  function viewSwitch(today) {
    const soon = allPlans().filter((p) => { const d = daysBetween(today, p.dateD); return d >= 0 && d < 7; });
    const hot = soon.some((p) => p.type === 'interview' && daysBetween(today, p.dateD) <= 2);
    const badge = soon.length && saved.view !== 'life'
      ? `<span class="vbadge${hot ? ' hot' : ''}" title="${soon.length} plan${soon.length === 1 ? '' : 's'} in the next 7 days">${soon.length}</span>` : '';
    return `<span class="vswitch" role="tablist" aria-label="View">
      <button type="button" role="tab" data-view="uni" class="${saved.view === 'uni' ? 'on' : ''}" aria-selected="${saved.view === 'uni'}">Uni</button>
      <button type="button" role="tab" data-view="life" class="${saved.view === 'life' ? 'on' : ''}" aria-selected="${saved.view === 'life'}">Life${badge}</button>
      <button type="button" role="tab" data-view="study" class="${saved.view === 'study' ? 'on' : ''}" aria-selected="${saved.view === 'study'}">Study${studyBadge()}</button>
    </span>`;
  }

  // ---------- cards ----------
  function renderOverview(n, today, tasks, cws) {
    const h = n.getHours();
    const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = String(data.name ?? '').trim();
    const s = semesterInfo(today);

    let semText = '', pct = 0, pctText = '';
    if (s) {
      const total = s.weeks * 7;
      if (s.elapsed < 0) {
        const when = -s.elapsed <= 13 ? `in ${plural(-s.elapsed, 'day')}` : `${DAY_KEYS[s.start.getDay()]} ${s.start.getDate()} ${MONTHS[s.start.getMonth()]}`;
        semText = s.between ? `Break · ${s.name} starts ${when}` : `${s.name} starts ${when}`;
      } else if (s.week > s.weeks) {
        semText = `${s.name} · teaching finished`;
        pct = 100;
        pctText = '100%';
      } else {
        semText = `Week ${s.week} of ${s.weeks} · ${s.name}${s.breakWeeks.includes(s.week) ? ' · break' : ''}`;
        pct = Math.round(((s.elapsed + 1) / total) * 100);
        pctText = `${pct}%`;
      }
    }

    const mods = currentModules(today);
    const credits = mods.reduce((sum, m) => sum + (Number(m.credits) || 0), 0);
    const modTitle = mods.map((m) => `${m.code} · ${m.name}${m.credits ? ` (${m.credits} cr)` : ''}`).join('\n');
    const left = deadlineItems(today, tasks, cws).filter((t) => !t.done);
    const overdue = left.filter((t) => t.dueD && t.dueD < today).length;
    const thisWeek = left.filter((t) => t.dueD && t.dueD >= today && daysBetween(today, t.dueD) < 7).length;
    const taskSub = overdue
      ? `<small class="danger">${overdue} overdue</small>`
      : left.length === 0
        ? '<small class="ok">All done</small>'
        : `<small>${thisWeek} due this week</small>`;

    els.overview.innerHTML = `
      <div>
        <div class="greet"><span>${esc(part)}${name ? `, ${esc(name)}` : ''}</span>${data.sample ? '<button type="button" class="sample" data-open-settings title="Set up your own timetable, deadlines and modules"><span class="long">Set up</span><span class="short">Set up</span></button>' : ''}${gearButton()}</div>
        <div class="date-row"><div class="date">${dateHtml(today)}</div>${viewSwitch(today)}</div>
      </div>
      ${s ? `<div>
        <div class="semline"><span>${esc(semText)}</span><span>${pctText}</span></div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </div>` : ''}
      <div class="stats">
        <div class="stat" title="${esc(modTitle)}"><b>${mods.length}</b><span>${mods.length === 1 ? 'Module' : 'Modules'}</span><small>${credits ? `${credits} credits` : `this ${termWord().toLowerCase()}`}</small></div>
        <div class="stat"><b>${left.length}</b><span>${left.length === 1 ? 'Task left' : 'Tasks left'}</span>${taskSub}</div>
      </div>`;
  }

  function nextClassAfter(n, today) {
    const nowMin = n.getHours() * 60 + n.getMinutes();
    for (let i = 0; i <= 21; i++) {
      const day = addDays(today, i);
      const ev = eventsOn(day).find((e) => i > 0 || e.s > nowMin);
      if (ev) return { day, ev, offset: i };
    }
    return null;
  }

  // One row of a day's timeline (a class, or a plan such as an interview).
  function evRow(e, nowMin, current, upcoming) {
    const status = e === current ? 'now' : e.e <= nowMin ? 'past' : e === upcoming && !current ? 'next' : '';
    let tag = status === 'now' ? '<span class="tag now">Now</span>' : status === 'next' ? '<span class="tag next">Next</span>' : '';
    if (e.link && status !== 'past') {
      tag = `<button class="tag join${status === 'now' ? ' now' : ''}" type="button" data-link="${esc(e.link)}" title="Join: ${esc(e.link)}">Join</button>`;
    }
    const title = e.title || moduleName(e.module);
    const typeText = [e.type, e.group ? `Group ${e.group}` : ''].filter(Boolean).join(' ');
    const tip = [`${e.start}–${e.end || ''} ${title}`, typeText, e.room, e.staff, e.notes].filter(Boolean).join(' · ')
      + (e.planId ? '\nClick to edit' : '');
    const detailHtml = [kindHtml(e), esc(e.room || '')].filter(Boolean).join(' · ');
    return `<li class="ev ${status}"${e.planId ? ` data-plan="${esc(e.planId)}"` : ''} style="--c:${e.color || moduleColor(e.module)}" title="${esc(tip)}">
      <span class="time">${esc(e.start)}<small>${esc(e.end || '')}</small></span>
      <span class="stripe"></span>
      <span class="title">${esc(title)}</span>
      <span class="sub">${detailHtml}</span>
      ${tag}
    </li>`;
  }

  // One "Tomorrow" heads-up line for interviews (both views) and tutorials
  // (Uni view), so there's time to prepare. Hover for the full details.
  function tomorrowNote(today, withTutorials) {
    const tomorrow = addDays(today, 1);
    const ivs = plansOn(tomorrow).filter((p) => p.type === 'interview');
    const tuts = withTutorials ? eventsOn(tomorrow).filter((e) => kindClass(e.type) === 'tutorial') : [];
    if (!ivs.length && !tuts.length) return '';
    const parts = [];
    const tips = [];
    for (const p of ivs) {
      parts.push(`<span class="tn iv">Interview</span> <b>${esc(p.title)}</b>${p.start ? ` ${esc(p.start)}` : ''}`);
      tips.push(['Interview', `${p.start || 'All day'} ${p.title}`, p.where, p.notes].filter(Boolean).join(' · '));
    }
    for (const e of tuts) {
      const name = e.title || moduleName(e.module) || 'Tutorial';
      parts.push(`<span class="tn tut">Tutorial</span> <b>${esc(name)}</b> ${esc(e.start)}${!ivs.length && tuts.length === 1 && e.room ? ` · ${esc(e.room)}` : ''}`);
      tips.push(['Tutorial', `${e.start}–${e.end || ''} ${name}`, e.group ? `Group ${e.group}` : '', e.room, e.staff].filter(Boolean).join(' · '));
    }
    const planAttr = ivs.length ? ` data-plan="${esc(ivs[0].id)}"` : '';
    return `<div class="note top tut${ivs.length ? ' iv' : ''}"${planAttr} title="${esc(`Tomorrow\n${tips.join('\n')}`)}"><span class="tut-label">Tomorrow</span> ${parts.join(' · ')}</div>`;
  }

  function renderSchedule(n, today) {
    const nowMin = n.getHours() * 60 + n.getMinutes();
    const evs = eventsOn(today);
    const current = evs.find((e) => e.s <= nowMin && nowMin < e.e);
    const upcoming = evs.find((e) => e.s > nowMin);
    const classes = evs.filter((e) => e.source !== 'plan');
    const totalMin = classes.reduce((sum, e) => sum + (e.e - e.s), 0);

    let meta = '';
    if (current) meta = `ends in ${fmtDur(current.e - nowMin)}`;
    else if (upcoming) meta = `next in ${fmtDur(upcoming.s - nowMin)}`;
    else if (evs.length) meta = 'all done';

    let html = feedProblem('timetable', 'Uni timetable');
    for (const a of allDayOn(today)) html += `<div class="note top" title="${esc(a.title)}">All day: <b>${esc(cleanTitle(a.title))}</b></div>`;
    if (evs.length) {
      html += '<ul class="list">' + evs.map((e) => evRow(e, nowMin, current, upcoming)).join('') + '</ul>';
    } else {
      html += `<div class="empty"><b>No classes today</b>${today.getDay() % 6 === 0 ? 'Enjoy the weekend.' : 'A free day to catch up.'}</div>`;
    }

    if (!upcoming) {
      const next = nextClassAfter(n, today);
      if (next && next.offset > 0) {
        const when = next.offset === 1 ? 'Tomorrow' : next.offset < 7 ? DAY_LONG[next.day.getDay()] : shortDate(next.day);
        const nextTitle = next.ev.title || moduleName(next.ev.module);
        // Add "lecture"/"lab" etc. for data.js classes, unless the title already says it.
        const addType = next.ev.type && !next.ev.source && !nextTitle.toLowerCase().includes(next.ev.type.toLowerCase());
        html += `<div class="note">Next: <b>${when} ${esc(next.ev.start)}</b> · ${esc(nextTitle)}${addType ? ` ${esc(next.ev.type.toLowerCase())}` : ''}</div>`;
      }
    }

    const headMeta = classes.length ? `${classes.length} ${classes.length === 1 ? 'class' : 'classes'} · ${fmtHours(totalMin)}${meta ? ` · ${meta}` : ''}` : meta;
    // The heads-ups sit above the scrolling list so they're always visible.
    els.schedule.innerHTML = head('clock', "Today's schedule", headMeta, feedStatus('timetable', 'Uni timetable'))
      + tomorrowNote(today, true)
      + `<div class="card-body" data-scroll="schedule">${html}</div>`;
  }

  function dueChip(n) {
    if (n < 0) return `<span class="chip danger">${-n}d overdue</span>`;
    if (n === 0) return '<span class="chip danger">Today</span>';
    if (n === 1) return '<span class="chip warn">Tomorrow</span>';
    return null;
  }

  // Everything with a deadline: your own tasks plus coursework (including Learn).
  // Learn can't tell us what you've submitted, so its deadlines drop off once the day has passed.
  function deadlineItems(today, tasks, cws) {
    return [
      ...tasks.map((t) => ({ ...t, kind: 't' })),
      ...cws
        .filter((c) => !(c.source === 'learn' && c.dueD && daysBetween(today, c.dueD) < 0))
        .map((c) => ({ ...c, kind: 'c', done: c.submitted })),
    ];
  }

  function renderDue(today, tasks, cws) {
    const items = deadlineItems(today, tasks, cws);
    const soon = items
      .filter((t) => (!t.done || recentlyTicked.has(`${t.kind}:${t.id}`)) && t.dueD && daysBetween(today, t.dueD) < SOON_DAYS)
      .sort(byDue);
    const later = items.filter((t) => !t.done && !soon.includes(t)).length;

    let html;
    if (soon.length) {
      html = '<ul class="list">' + soon.map((t) => {
        const d = daysBetween(today, t.dueD);
        const chip = dueChip(d) || `<span class="chip${d <= 3 ? ' warn' : ''}">${d < 7 ? DAY_KEYS[t.dueD.getDay()] : `${t.dueD.getDate()} ${MONTHS[t.dueD.getMonth()]}`}</span>`;
        const attr = t.kind === 't' ? `data-task="${esc(t.id)}"` : `data-cw="${esc(t.id)}"`;
        const verb = t.kind === 't' ? ['Mark done', 'Mark not done'] : ['Mark submitted', 'Mark not submitted'];
        return `<li class="task${t.done ? ' is-done' : ''}"${t.kind === 'c' ? ` data-edit="${esc(t.id)}"` : ''} style="--c:${moduleColor(t.module)}" title="${esc(`${t.title}\nDue ${shortDate(t.dueD)}${t.time ? ` ${t.time}` : ''}${t.source === 'learn' ? ` · from ${dlName()}` : ''}`)}">
          <button class="check" type="button" ${attr} aria-pressed="${!!t.done}" aria-label="${t.done ? verb[1] : verb[0]}: ${esc(t.title)}">${TICK}</button>
          <span class="title">${esc(t.title)}</span>
          <span class="sub">${subLine(t, [t.time])}</span>
          ${chip}
        </li>`;
      }).join('') + '</ul>';
    } else {
      html = `<div class="empty"><b>Nothing due in the next ${SOON_DAYS / 7} weeks</b>${later ? 'Get ahead on what’s next.' : 'You’re all caught up.'}</div>`;
    }
    if (later) html += `<div class="more">+${later} more later</div>`;

    const open = soon.filter((t) => !t.done).length;
    els.due.innerHTML = head('check', 'Due soon', open ? `${open} in the next ${SOON_DAYS} days` : '', feedStatus('learn', dlName())) + `<div class="card-body" data-scroll="due">${html}</div>`;
  }

  // "Opens Fri 30 Oct" before release, "Out now" for the first week after.
  function releaseText(c, today) {
    const rel = parseDate(c.release);
    if (!rel) return '';
    const since = daysBetween(rel, today);
    if (since < 0) return `Opens ${shortDate(rel)}`;
    return since <= 6 ? 'Out now' : '';
  }

  function renderCoursework(n, today, cws) {
    // Learn can't tell us what you've submitted, so its deadlines drop off once the day has passed.
    const current = cws.filter((c) => !(c.source === 'learn' && c.dueD && daysBetween(today, c.dueD) < 0));
    const shown = current.filter((c) => !c.submitted || recentlyTicked.has(`c:${c.id}`)).sort(byDue);
    const open = current.filter((c) => !c.submitted);
    const nowMin = n.getHours() * 60 + n.getMinutes();

    let html;
    if (shown.length) {
      html = '<ul class="list">' + shown.map((c) => {
        let chip = '';
        if (c.dueD) {
          const d = daysBetween(today, c.dueD);
          const t = toMin(c.time);
          if (d < 0 || (d === 0 && t != null && t <= nowMin)) chip = '<span class="chip danger">Overdue</span>';
          else if (d === 0) chip = `<span class="chip danger">${t != null ? `Due ${esc(c.time)}` : 'Today'}</span>`;
          else if (d === 1) chip = '<span class="chip danger">Tomorrow</span>';
          else chip = `<span class="chip ${d <= 7 ? 'warn' : 'ok'}">${d} days</span>`;
        }
        const when = c.dueD ? `${shortDate(c.dueD)}${c.time ? ` ${c.time}` : ''}` : 'No date';
        const weight = Number(c.weight) ? `${Number(c.weight)}%` : '';
        const progressText = c.progress == null ? '' : ` · ${c.progress}% done`;
        return `<li class="cw${c.submitted ? ' is-done' : ''}" data-edit="${esc(c.id)}" style="--c:${moduleColor(c.module)}" title="${esc(`${c.title}\n${moduleName(c.module) || c.course || ''} · ${when}${weight ? ` · worth ${weight}` : ''}${progressText}${c.source === 'learn' ? ` · from ${dlName()}` : ''}\nClick to edit`)}">
          <button class="check" type="button" data-cw="${esc(c.id)}" aria-pressed="${c.submitted}" aria-label="${c.submitted ? 'Mark not submitted' : 'Mark submitted'}: ${esc(c.title)}">${TICK}</button>
          <span class="title${c.link ? ' has-link' : ''}">${esc(c.title)}</span>
          ${c.link ? `<button class="row-link" type="button" data-link="${esc(c.link)}" title="Open ${esc(c.link)}" aria-label="Open link">↗</button>` : ''}
          <span class="sub">${subLine(c, [releaseText(c, today), weight, when, focusSpent(c.id)])}</span>
          ${chip}
          ${c.progress == null ? '' : `<span class="prog" aria-label="${c.progress}% done"><i style="width:${c.progress}%"></i></span>`}
        </li>`;
      }).join('') + '</ul>';
    } else {
      html = cws.length
        ? '<div class="empty"><b>No coursework left</b>Everything has been submitted.</div>'
        : '<div class="empty"><b>No coursework yet</b>Click + Add to add one.</div>';
    }
    html = feedProblem('learn', dlName()) + html;
    // A small count badge instead of meta text: leaves room for the "+ Add" button.
    const count = open.length ? `<span class="count" title="${open.length} to submit">${open.length}</span>` : '';
    const addBtn = `${count}<button class="head-btn" type="button" data-add-cw title="Add coursework">+ Add</button>`;
    els.coursework.innerHTML = head('file', 'Upcoming coursework', '', feedStatus('learn', dlName()), addBtn, 'Coursework') + `<div class="card-body" data-scroll="coursework">${html}</div>`;
  }

  function renderWeek(today, tasks, cws) {
    const offset = (today.getDay() + 6) % 7; // days since Monday
    const weekend = offset >= 5;
    const monday = addDays(today, weekend ? 7 - offset : -offset);
    const s = semesterInfo(monday);
    const inTeaching = s && s.elapsed >= 0 && s.week <= s.weeks;

    let totalMin = 0, totalDue = 0;
    const cols = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      const evs = eventsOn(day);
      const mins = evs.filter((e) => e.source !== 'plan').reduce((sum, e) => sum + (e.e - e.s), 0);
      const interview = plansOn(day).some((p) => p.type === 'interview');
      const dueItems = [
        ...tasks.filter((t) => !t.done && t.dueD && daysBetween(t.dueD, day) === 0).map((t) => t.title),
        ...cws.filter((c) => !c.submitted && c.dueD && daysBetween(c.dueD, day) === 0).map((c) => `${c.title} (coursework)`),
      ];
      const hasCw = cws.some((c) => !c.submitted && c.dueD && daysBetween(c.dueD, day) === 0);
      totalMin += mins;
      totalDue += dueItems.length;

      const diff = daysBetween(today, day);
      const cls = ['day', diff === 0 && 'today', diff < 0 && 'past', i >= 5 && 'weekend'].filter(Boolean).join(' ');
      const tip = [shortDate(day), ...allDayOn(day).map((a) => `All day: ${cleanTitle(a.title)}`),
        ...evs.map((e) => (e.source === 'plan' ? `${e.start} ${e.type}: ${e.title}` : `${e.start} ${moduleCode(e.module)} ${e.type || ''}`.trim())),
        ...(dueItems.length ? ['Due:', ...dueItems.map((d) => `• ${d}`)] : [])].join('\n');
      const pips = evs.map((e) => `<i style="--c:${e.color || moduleColor(e.module)}"></i>`).join('');
      // Deadlines first; otherwise flag an interview day.
      const badge = dueItems.length
        ? `<span class="dl ${hasCw ? 'danger' : 'warn'}">${dueItems.length} due</span>`
        : interview ? `<span class="dl iv" title="Interview">${icon('briefcase')}</span>` : '<span class="dl"></span>';
      cols.push(`<div class="${cls}" title="${esc(tip)}">
        <span class="dn">${DAY_KEYS[day.getDay()]}</span>
        <span class="dd">${day.getDate()}</span>
        <div class="pips">${pips}</div>
        <span class="dh">${mins ? fmtHours(mins) : '–'}</span>
        ${badge}
      </div>`);
    }

    const label = weekend ? 'Next week' : 'This week';
    const meta = `${inTeaching ? `Week ${s.week} · ` : ''}${fmtHours(totalMin)} classes · ${totalDue} due`;
    els.week.innerHTML = head('calendar', label, meta) + `<div class="card-body" data-scroll="week"><div class="days">${cols.join('')}</div></div>`;
  }

  // ---------- Life view ----------
  function whenText(p) {
    const time = p.start ? ` ${p.start}${p.end ? `–${p.end}` : ''}` : '';
    return `${shortDate(p.dateD)}${time}`;
  }
  function planChip(p, today, nowMin) {
    const d = daysBetween(today, p.dateD);
    if (d === 0) {
      const over = (p.e ?? p.s) != null && (p.e ?? (p.s + 60)) <= nowMin;
      return `<span class="chip ${over ? '' : 'danger'}">${over ? 'Done' : p.start ? `Today ${esc(p.start)}` : 'Today'}</span>`;
    }
    if (d === 1) return '<span class="chip warn">Tomorrow</span>';
    if (d < 7) return `<span class="chip">${DAY_KEYS[p.dateD.getDay()]}</span>`;
    return `<span class="chip">${d} days</span>`;
  }
  function planRow(p, today, nowMin) {
    const t = planType(p);
    const where = p.where ? (isLink(p.where) ? 'Online' : p.where) : '';
    const sub = [p.type === 'interview' ? '' : t.label, whenText(p), where].filter(Boolean).join(' · ');
    const link = isLink(p.where)
      ? `<button class="row-link" type="button" data-link="${esc(p.where.trim())}" title="Open ${esc(p.where.trim())}" aria-label="Open link">↗</button>` : '';
    const tip = [p.title, `${t.label} · ${whenText(p)}`, p.where, p.notes, 'Click to edit'].filter(Boolean).join('\n');
    return `<li class="plan" data-plan="${esc(p.id)}" style="--c:${t.color}" title="${esc(tip)}">
      <span class="stripe"></span>
      <span class="title${link ? ' has-link' : ''}">${esc(p.title)}</span>
      ${link}
      <span class="sub">${esc(sub)}</span>
      ${planChip(p, today, nowMin)}
    </li>`;
  }
  const upcomingPlans = (today) => allPlans().filter((p) => daysBetween(today, p.dateD) >= 0);
  const addPlanBtn = (type, label) => `<button class="head-btn" type="button" data-add-plan="${type}" title="Add ${label.toLowerCase()}">+ Add</button>`;

  function renderLifeOverview(n, today) {
    const h = n.getHours();
    const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = String(data.name ?? '').trim();
    const upcoming = upcomingPlans(today);
    const interviews = upcoming.filter((p) => p.type === 'interview');
    const week = upcoming.filter((p) => daysBetween(today, p.dateD) < 7);
    const next = interviews[0];
    let line = 'No interviews scheduled';
    if (next) {
      const d = daysBetween(today, next.dateD);
      line = `Next interview ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`}: ${next.title}`;
    }
    els.overview.innerHTML = `
      <div>
        <div class="greet"><span>${esc(part)}${name ? `, ${esc(name)}` : ''}</span>${gearButton()}</div>
        <div class="date-row"><div class="date">${dateHtml(today)}</div>${viewSwitch(today)}</div>
      </div>
      <div class="semline life-line" title="${esc(line)}"><span>${esc(line)}</span></div>
      <div class="stats">
        <div class="stat"><b>${interviews.length}</b><span>${interviews.length === 1 ? 'Interview' : 'Interviews'}</span><small>${next ? `next ${esc(shortDate(next.dateD))}` : 'none yet'}</small></div>
        <div class="stat"><b>${week.length}</b><span>${week.length === 1 ? 'Plan' : 'Plans'}</span><small>next 7 days</small></div>
      </div>`;
  }

  function renderLifeToday(n, today) {
    const nowMin = n.getHours() * 60 + n.getMinutes();
    const timed = plansOn(today).filter((p) => p.s != null).map(planAsEvent)
      .map((e) => ({ ...e, s: toMin(e.start), e: toMin(e.end) }))
      .map((e) => ({ ...e, e: e.e != null && e.e > e.s ? e.e : e.s + 60 }));
    const allDay = plansOn(today).filter((p) => p.s == null);
    const current = timed.find((e) => e.s <= nowMin && nowMin < e.e);
    const upcoming = timed.find((e) => e.s > nowMin);
    let html = allDay.map((p) => `<div class="note top" data-plan="${esc(p.id)}" title="${esc([p.title, p.where, p.notes].filter(Boolean).join(' · '))}">All day: <b>${esc(p.title)}</b>${p.type !== 'plan' ? ` · ${esc(planType(p).label)}` : ''}</div>`).join('');
    if (timed.length) html += '<ul class="list">' + timed.map((e) => evRow(e, nowMin, current, upcoming)).join('') + '</ul>';
    else if (!allDay.length) {
      const next = upcomingPlans(today).find((p) => daysBetween(today, p.dateD) > 0);
      html += `<div class="empty"><b>Nothing planned today</b>${next ? `Next: ${esc(next.title)}, ${esc(whenText(next))}` : 'Add interviews and plans with + Add.'}</div>`;
    }
    const meta = current ? `ends in ${fmtDur(current.e - nowMin)}` : upcoming ? `next in ${fmtDur(upcoming.s - nowMin)}` : '';
    els.schedule.innerHTML = head('sun', "Today's plans", meta) + tomorrowNote(today, false)
      + `<div class="card-body" data-scroll="life-today">${html}</div>`;
  }

  function renderInterviews(n, today) {
    const nowMin = n.getHours() * 60 + n.getMinutes();
    const ivs = upcomingPlans(today).filter((p) => p.type === 'interview');
    const html = ivs.length
      ? `<ul class="list">${ivs.map((p) => planRow(p, today, nowMin)).join('')}</ul>`
      : '<div class="empty"><b>No interviews scheduled</b>Click + Add when you get one. Good luck!</div>';
    const count = ivs.length ? `<span class="count">${ivs.length}</span>` : '';
    els.due.innerHTML = head('briefcase', 'Interviews', '', null, count + addPlanBtn('interview', 'Interview')) + `<div class="card-body" data-scroll="interviews">${html}</div>`;
  }

  function renderPlans(n, today) {
    const nowMin = n.getHours() * 60 + n.getMinutes();
    const plans = upcomingPlans(today).filter((p) => p.type !== 'interview');
    const html = plans.length
      ? `<ul class="list">${plans.map((p) => planRow(p, today, nowMin)).join('')}</ul>`
      : '<div class="empty"><b>No plans yet</b>Add events, application deadlines and anything else with + Add.</div>';
    const count = plans.length ? `<span class="count">${plans.length}</span>` : '';
    els.coursework.innerHTML = head('list', 'Plans', '', null, count + addPlanBtn('plan', 'Plan')) + `<div class="card-body" data-scroll="plans">${html}</div>`;
  }

  function renderLifeWeek(today) {
    const offset = (today.getDay() + 6) % 7;
    const weekend = offset >= 5;
    const monday = addDays(today, weekend ? 7 - offset : -offset);
    let total = 0, interviewCount = 0;
    const cols = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      const plans = plansOn(day);
      const ivs = plans.filter((p) => p.type === 'interview');
      total += plans.length;
      interviewCount += ivs.length;
      const diff = daysBetween(today, day);
      const cls = ['day', diff === 0 && 'today', diff < 0 && 'past', i >= 5 && 'weekend'].filter(Boolean).join(' ');
      const tip = [shortDate(day), ...plans.map((p) => `${p.start || 'All day'} ${planType(p).label}: ${p.title}`)].join('\n');
      const pips = plans.map((p) => `<i style="--c:${planType(p).color}"></i>`).join('');
      cols.push(`<div class="${cls}" title="${esc(tip)}">
        <span class="dn">${DAY_KEYS[day.getDay()]}</span>
        <span class="dd">${day.getDate()}</span>
        <div class="pips">${pips}</div>
        <span class="dh">${plans.length ? `${plans.length} plan${plans.length === 1 ? '' : 's'}` : '–'}</span>
        ${ivs.length ? `<span class="dl iv" title="Interview">${icon('briefcase')}</span>` : '<span class="dl"></span>'}
      </div>`);
    }
    const meta = `${total} plan${total === 1 ? '' : 's'} · ${interviewCount} interview${interviewCount === 1 ? '' : 's'}`;
    els.week.innerHTML = head('calendar', weekend ? 'Next week' : 'This week', meta) + `<div class="card-body" data-scroll="life-week"><div class="days">${cols.join('')}</div></div>`;
  }

  // ---------- "Today at a glance" pop-up ----------
  // Shown by the desktop app the first time the laptop is used each day.
  const listText = (parts) => (parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // Everything on a day: classes, plans/interviews and deadlines, in time order.
  function dayItems(day, today, tasks, cws) {
    const items = [];
    for (const a of allDayOn(day)) {
      const kind = a.planKind === 'interview' ? 'interview' : a.planKind === 'deadline' ? 'due' : a.source === 'plan' ? 'plan' : 'class';
      items.push({ t: -1, when: 'All day', title: cleanTitle(a.title), detail: a.type || '', kind, color: a.color || 'var(--c-slate)' });
    }
    for (const e of eventsOn(day)) {
      const kind = e.source === 'plan'
        ? (e.planKind === 'interview' ? 'interview' : e.planKind === 'deadline' ? 'due' : 'plan')
        : kindClass(e.type) === 'exam' ? 'exam' : 'class';
      items.push({
        t: e.s, end: e.e, when: e.end ? `${e.start}–${e.end}` : e.start, kind,
        title: e.title || moduleName(e.module),
        detail: [[e.type, e.group ? `group ${e.group}` : ''].filter(Boolean).join(' '), e.room].filter(Boolean).join(' · '),
        color: e.color || moduleColor(e.module),
      });
    }
    for (const d of deadlineItems(today, tasks, cws)) {
      if (d.done || !d.dueD || daysBetween(d.dueD, day) !== 0) continue;
      const label = d.module ? moduleName(d.module) : cleanCourse(d.course) || (d.source === 'learn' ? dlName() : '');
      items.push({ t: toMin(d.time) ?? 1439, when: d.time ? `Due ${d.time}` : 'Due', title: d.title, detail: [label, d.weight ? `${d.weight}%` : ''].filter(Boolean).join(' · '), kind: 'due', color: moduleColor(d.module) });
    }
    return items.sort((a, b) => a.t - b.t);
  }

  function summaryItem(it, whenText, past) {
    return `<li class="si k-${it.kind}${past ? ' past' : ''}" style="--c:${it.color}">
      <span class="si-when">${esc(whenText ?? it.when)}</span>
      <span class="si-bar"></span>
      <span class="si-main"><b>${esc(it.title)}</b>${it.detail ? `<small>${esc(it.detail)}</small>` : ''}</span>
    </li>`;
  }

  function dayPhrase(items, isToday, nowMin) {
    const classes = items.filter((i) => i.kind === 'class' && i.t >= 0 && !(isToday && i.end <= nowMin));
    const ivs = items.filter((i) => i.kind === 'interview');
    const dues = items.filter((i) => i.kind === 'due');
    const exams = items.filter((i) => i.kind === 'exam');
    const parts = [];
    if (classes.length) parts.push(`${count(classes.length, 'class', 'classes')}${isToday && items.some((i) => i.kind === 'class' && i.end <= nowMin) ? ' left' : ''} from ${classes[0].when.split('–')[0]}`);
    if (exams.length) parts.push(count(exams.length, 'exam', 'exams'));
    for (const iv of ivs) parts.push(`an interview${iv.t >= 0 ? ` at ${iv.when.split('–')[0]}` : ''}`);
    if (dues.length) parts.push(count(dues.length, 'deadline', 'deadlines'));
    return parts.length ? listText(parts) : 'nothing scheduled';
  }

  function renderSummary() {
    const root = document.getElementById('summary');
    if (!root) return;
    if (!data) {
      root.innerHTML = `<div class="sum-error"><b>Couldn’t read ${esc(window.__dataFile || 'data.js')}</b><span>${esc(dataError || 'The file is missing or has a typo.')}</span></div>`;
      return;
    }
    if (window.DASHBOARD_REVIEW || params.has('review')) { renderReview(); return; }
    const n = now();
    const today = startOfDay(n);
    const nowMin = n.getHours() * 60 + n.getMinutes();
    moduleMap = new Map(list('modules').map((m) => [String(m.code ?? '').toLowerCase(), m]));
    const tasks = allTasks();
    const cws = allCoursework();
    const tomorrow = addDays(today, 1);

    const todayItems = dayItems(today, today, tasks, cws);
    const tomorrowItems = dayItems(tomorrow, today, tasks, cws);

    // Next 7 days: only the important things (deadlines, interviews, plans, exams).
    let weekMin = 0;
    const weekGroups = [];
    const weekKey = { due: 0, interview: 0, plan: 0, exam: 0 };
    for (let i = 0; i < 7; i++) {
      const day = addDays(today, i);
      const items = dayItems(day, today, tasks, cws);
      weekMin += items.filter((it) => it.kind === 'class' && it.t >= 0).reduce((sum, it) => sum + (it.end - it.t), 0);
      if (i < 2) continue;
      const key = items.filter((it) => it.kind !== 'class');
      key.forEach((it) => { weekKey[it.kind] = (weekKey[it.kind] || 0) + 1; });
      if (key.length) weekGroups.push({ day, key });
    }

    const overdue = deadlineItems(today, tasks, cws).filter((d) => !d.done && d.dueD && d.dueD < today);
    const weekParts = [];
    if (weekKey.due) weekParts.push(count(weekKey.due, 'deadline', 'deadlines'));
    if (weekKey.exam) weekParts.push(count(weekKey.exam, 'exam', 'exams'));
    if (weekKey.interview) weekParts.push(count(weekKey.interview, 'interview', 'interviews'));
    if (weekKey.plan) weekParts.push(count(weekKey.plan, 'plan', 'plans'));
    const sentence = [
      `<b>Today:</b> ${esc(dayPhrase(todayItems, true, nowMin))}.`,
      `<b>Tomorrow:</b> ${esc(dayPhrase(tomorrowItems, false, nowMin))}.`,
      `<b>Rest of the week:</b> ${esc(weekParts.length ? listText(weekParts) : 'nothing major')}.`,
    ].join(' ');

    const h = n.getHours();
    const greeting = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = String(data.name ?? '').trim();
    const sem = semesterInfo(today);
    const semText = sem && sem.elapsed >= 0 && sem.week <= sem.weeks ? ` · Week ${sem.week} of ${sem.weeks}` : '';
    const list_ = (items, empty, past) => (items.length
      ? `<ul class="si-list">${items.map((it) => summaryItem(it, null, past && it.t >= 0 && it.kind !== 'due' && (it.end ?? it.t) <= nowMin)).join('')}</ul>`
      : `<p class="si-empty">${empty}</p>`);
    const weekHtml = weekGroups.length
      ? `<ul class="si-list">${weekGroups.map((g) => g.key.map((it) => summaryItem(
        { ...it, detail: [it.when, it.detail].filter(Boolean).join(' · ') }, `${DAY_KEYS[g.day.getDay()]} ${g.day.getDate()}`, false,
      )).join('')).join('')}</ul>`
      : '<p class="si-empty">No deadlines, interviews or plans.</p>';

    root.innerHTML = `
      <header class="sum-head">
        <div>
          <h1>${esc(greeting)}${name ? `, ${esc(name)}` : ''}</h1>
          <p class="sum-date">${DAY_LONG[today.getDay()]} ${today.getDate()} ${MONTHS_LONG[today.getMonth()]}${semText}</p>
        </div>
        <div class="sum-actions">
          <button type="button" class="btn" data-sum="dashboard">Open dashboard</button>
          <button type="button" class="btn primary" data-sum="close">Close</button>
        </div>
      </header>
      <p class="sum-line">${sentence}${overdue.length ? ` <span class="sum-alert">${count(overdue.length, 'item is', 'items are')} overdue</span>` : ''}</p>
      <section class="sum-cols">
        <div class="sum-col"><h2>Today <span>${shortDate(today)}</span></h2>${list_(todayItems, 'Nothing scheduled. Enjoy the day!', true)}</div>
        <div class="sum-col"><h2>Tomorrow <span>${shortDate(tomorrow)}</span></h2>${list_(tomorrowItems, 'Nothing scheduled.', false)}</div>
        <div class="sum-col"><h2>Rest of the week <span>${DAY_KEYS[addDays(today, 2).getDay()]} ${addDays(today, 2).getDate()} – ${DAY_KEYS[addDays(today, 6).getDay()]} ${addDays(today, 6).getDate()}</span></h2>${weekHtml}
          <p class="sum-foot">${weekMin ? `${fmtHours(weekMin)} of classes in the next 7 days` : 'No classes in the next 7 days'}</p></div>
      </section>`;
  }

  if (SUMMARY) {
    document.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-sum]');
      if (!b || !apiReady()) return;
      if (b.dataset.sum === 'close') window.pywebview.api.close_summary();
      else window.pywebview.api.open_dashboard();
    });
  }

  function renderError() {
    grid.classList.add('error');
    grid.innerHTML = `<article class="card error-card"><b>Couldn’t read ${esc(window.__dataFile || 'data.js')}</b>
      <span>${esc(dataError || 'The file is missing or has a typo.')}</span>
      <span>Check for a missing comma, quote or bracket near the line you last edited, then save again.</span></article>`;
  }

  function render(scrollToNow) {
    rebuildData();
    if (SUMMARY) { renderSummary(); return; }
    if (!data) { renderError(); return; }
    const keep = {};
    document.querySelectorAll('[data-scroll]').forEach((el) => { keep[el.dataset.scroll] = el.scrollTop; });

    const n = now();
    const today = startOfDay(n);
    moduleMap = new Map(list('modules').map((m) => [String(m.code ?? '').toLowerCase(), m]));
    const tasks = allTasks();
    const cws = allCoursework();

    const parts = saved.view === 'study'
      ? [
        () => renderStudyOverview(n, today, tasks, cws),
        () => renderPlayer(),
        () => renderTimer(),
        () => renderDue(today, tasks, cws),
        () => renderFocusWeek(today),
      ]
      : saved.view === 'life'
      ? [
        () => renderLifeOverview(n, today),
        () => renderLifeToday(n, today),
        () => renderInterviews(n, today),
        () => renderPlans(n, today),
        () => renderLifeWeek(today),
      ]
      : [
        () => renderOverview(n, today, tasks, cws),
        () => renderSchedule(n, today),
        () => renderDue(today, tasks, cws),
        () => renderCoursework(n, today, cws),
        () => renderWeek(today, tasks, cws),
      ];
    grid.classList.toggle('life', saved.view === 'life');
    grid.classList.toggle('study', saved.view === 'study');
    for (const part of parts) {
      try { part(); } catch (err) { report(err); }
    }
    try { fitDate(); } catch (err) { report(err); }
    try { sendReminders(today, cws); } catch (err) { report(err); }

    document.querySelectorAll('[data-scroll]').forEach((el) => {
      if (scrollToNow && el.dataset.scroll === 'schedule') {
        const target = el.querySelector('.ev.now, .ev.next');
        if (target) el.scrollTop = Math.max(0, target.offsetTop - el.querySelector('.list').offsetTop - 4);
      } else if (keep[el.dataset.scroll] != null) {
        el.scrollTop = keep[el.dataset.scroll];
      }
    });
    lastMinute = `${iso(n)} ${n.getHours()}:${n.getMinutes()}`;
  }

  // ---------- saved ticks ----------
  // In the desktop app ticks are saved to state.json; in a browser, to localStorage.
  const apiReady = () => !!(window.pywebview && window.pywebview.api && typeof window.pywebview.api.get_state === 'function');

  async function loadSaved() {
    let obj = null;
    if (apiReady()) {
      try { obj = await window.pywebview.api.get_state(); } catch (err) { console.error(err); }
    } else {
      try { obj = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { obj = null; }
    }
    saved = {
      done: obj && typeof obj.done === 'object' && obj.done ? obj.done : {},
      submitted: obj && typeof obj.submitted === 'object' && obj.submitted ? obj.submitted : {},
      courseOf: obj && typeof obj.courseOf === 'object' && obj.courseOf ? obj.courseOf : {},
      plans: obj && Array.isArray(obj.plans) ? obj.plans.filter((p) => p && p.id && p.title && p.date) : [],
      view: obj && (obj.view === 'life' || obj.view === 'study') ? obj.view : 'uni',
      coursework: obj && Array.isArray(obj.coursework) ? obj.coursework.filter((c) => c && c.id && c.title) : [],
      cwMeta: obj && typeof obj.cwMeta === 'object' && obj.cwMeta && !Array.isArray(obj.cwMeta) ? obj.cwMeta : {},
    };
    settings = obj && typeof obj.settings === 'object' && obj.settings ? obj.settings : {};
    rebuildData();
    applyTheme();
  }
  function persist() {
    if (apiReady()) {
      Promise.resolve(window.pywebview.api.save_state(saved)).catch((err) => console.error(err));
    } else {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ }
    }
  }

  // ---------- theme ----------
  // data.js  theme:  "auto" (follow Windows light/dark), "windows-dark",
  // "windows-light", "sage", "sand" or "midnight". The Windows themes use your
  // Windows accent colour. ?theme=... in the address overrides it (previewing).
  const THEMES = ['windows-dark', 'windows-light', 'sage', 'sand', 'midnight'];
  let systemTheme = null; // { dark, accentLight, accentDark } from the desktop app
  const isHex = (c) => /^#[0-9a-f]{6}$/i.test(String(c || ''));

  function applyTheme() {
    const wanted = String(params.get('theme') || (data && data.theme) || 'auto').trim().toLowerCase();
    const dark = systemTheme ? !!systemTheme.dark : !window.matchMedia('(prefers-color-scheme: light)').matches;
    const name = wanted === 'auto' ? (dark ? 'windows-dark' : 'windows-light') : wanted;
    const theme = THEMES.includes(name) ? name : 'windows-dark';
    const root = document.documentElement;
    root.dataset.theme = theme;
    const accent = !systemTheme ? null
      : theme === 'windows-dark' ? systemTheme.accentLight
      : theme === 'windows-light' ? systemTheme.accentDark : null;
    if (isHex(accent)) root.style.setProperty('--accent', accent);
    else root.style.removeProperty('--accent');
  }
  async function loadSystemTheme() {
    if (!(apiReady() && typeof window.pywebview.api.get_system_theme === 'function')) return;
    try { systemTheme = await window.pywebview.api.get_system_theme(); } catch (err) { report(err); }
    applyTheme();
  }
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

  // ---------- deadline reminders ----------
  // The desktop app shows the notifications; it just needs the current list of
  // upcoming coursework you haven't submitted. Sent only when something changed.
  let lastReminderList = '';
  let savedLoaded = false; // don't send anything until your ticks/added coursework have loaded
  function sendReminders(today, cws) {
    if (!savedLoaded || !(apiReady() && typeof window.pywebview.api.set_reminders === 'function')) return;
    if (params.has('date') || params.has('time')) return; // previewing another day
    const items = cws
      .filter((c) => !c.submitted && c.dueD && daysBetween(today, c.dueD) >= 0)
      .map((c) => ({
        id: c.id, kind: 'coursework', title: c.title, due: iso(c.dueD), time: c.time || '',
        course: c.module ? moduleName(c.module) : cleanCourse(c.course),
      }))
      // Interviews: reminded the day before and an hour before.
      .concat(allPlans()
        .filter((p) => p.type === 'interview' && daysBetween(today, p.dateD) >= 0)
        .map((p) => ({
          id: p.id, kind: 'interview', title: p.title, due: p.date, time: p.start || '',
          course: p.where ? (isLink(p.where) ? 'Online' : p.where) : '',
        })));
    const key = JSON.stringify(items);
    if (key === lastReminderList) return;
    lastReminderList = key;
    Promise.resolve(window.pywebview.api.set_reminders(items)).catch(report);
  }

  // ---------- add / edit coursework ----------
  // The form is its own element on top of the cards, so the regular re-render
  // (every minute) never wipes what you're typing.
  let editor = null; // { id, source, el, confirmDelete }

  function holdPanel(on) {
    if (apiReady() && typeof window.pywebview.api.set_hold === 'function') {
      Promise.resolve(window.pywebview.api.set_hold(!!on)).catch(() => {});
    }
  }
  function openLink(url) {
    if (apiReady() && typeof window.pywebview.api.open_url === 'function') window.pywebview.api.open_url(url);
    else window.open(url, '_blank', 'noopener');
  }
  const newId = () => `my:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  function openEditor(id) {
    closeEditor();
    const item = id ? allCoursework().find((c) => c.id === id) : null;
    if (id && !item) return;
    const locked = !!item && item.source !== 'mine'; // title & date come from Learn / your data file
    const v = item
      ? { title: item.title, module: item.module || '', due: item.dueD ? iso(item.dueD) : '', time: item.time || '',
          weight: Number(item.weight) || '', progress: item.progress ?? 0, link: item.link || '', release: item.release || '' }
      : { title: '', module: '', due: '', time: '12:00', weight: '', progress: 0, link: '', release: '' };
    const from = item && item.source === 'learn' ? dlName() : item && item.source === 'file' ? 'your data file' : '';
    const options = list('modules').map((m) => {
      const sel = String(m.code).toLowerCase() === String(v.module).toLowerCase() ? ' selected' : '';
      return `<option value="${esc(m.code)}"${sel}>${esc(m.name || m.code)}</option>`;
    }).join('');
    const dis = locked ? ' disabled' : '';

    const el = document.createElement('div');
    el.className = 'editor';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', item ? 'Edit coursework' : 'Add coursework');
    el.innerHTML = `
      <header class="ed-head">
        <h2 class="card-title">${item ? 'Edit coursework' : 'Add coursework'}</h2>
        ${item ? '' : modeSwitch('one')}
        <span class="ed-msg">${from ? `Title and due date come from ${from}.` : 'Press Enter to save, Esc to cancel.'}</span>
        <button type="button" class="ed-x" data-ed="cancel" aria-label="Close">✕</button>
      </header>
      <form class="ed-form" novalidate>
        <label class="f-title"><span>Title</span><input name="title" maxlength="200" placeholder="e.g. Coursework 2: Fuzzing report" value="${esc(v.title)}"${dis}></label>
        <label class="f-course"><span>Course</span><select name="module"><option value="">Choose a course…</option>${options}</select></label>
        <label class="f-due"><span>Due date</span><input type="date" name="due" value="${esc(v.due)}"${dis}></label>
        <label class="f-time"><span>Time</span><input type="time" name="time" value="${esc(v.time)}"${dis}></label>
        <label class="f-weight"><span>Weight %</span><input type="number" name="weight" min="0" max="100" step="1" placeholder="e.g. 25" value="${esc(v.weight)}"></label>
        <label class="f-release"><span>Released</span><input type="date" name="release" value="${esc(v.release)}"></label>
        <label class="f-prog"><span>Progress <output>${esc(v.progress)}%</output></span><input type="range" name="progress" min="0" max="100" step="5" value="${esc(v.progress)}"></label>
        <label class="f-link"><span>Link (optional)</span><input type="url" name="link" maxlength="500" placeholder="https://… (course page, submission page, spec)" value="${esc(v.link)}"></label>
        <div class="f-actions">
          ${item && item.source === 'mine' ? '<button type="button" class="btn danger" data-ed="delete">Delete</button>' : ''}
          <button type="button" class="btn" data-ed="cancel">Cancel</button>
          <button type="submit" class="btn primary">${item ? 'Save' : 'Add'}</button>
        </div>
      </form>`;

    el.addEventListener('input', (e) => {
      if (e.target.name === 'progress') el.querySelector('output').textContent = `${e.target.value}%`;
    });
    el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); saveEditor(); });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ed]');
      if (!b) return;
      if (b.dataset.ed === 'cancel') closeEditor();
      else if (b.dataset.ed === 'delete') deleteFromEditor(b);
      else if (b.dataset.ed === 'paste') openImport();
    });

    panel.appendChild(el);
    editor = { id: item ? item.id : null, source: item ? item.source : 'mine', el, confirmDelete: false };
    holdPanel(true);
    const first = el.querySelector(locked ? 'select' : 'input[name=title]');
    if (first) first.focus();
  }

  function closeEditor() {
    if (!editor) return;
    editor.el.remove();
    editor = null;
    holdPanel(false);
  }

  function editorError(text, field) {
    const msg = editor.el.querySelector('.ed-msg');
    msg.textContent = text;
    msg.classList.add('err');
    const input = field && editor.el.querySelector(`[name=${field}]`);
    if (input) input.focus();
  }

  function saveEditor() {
    const f = editor.el.querySelector('form');
    const val = (name) => String(f.elements[name] ? f.elements[name].value : '').trim();
    const weight = clampPct(val('weight'));
    const progress = clampPct(val('progress')) ?? 0;
    const link = val('link');
    if (val('weight') !== '' && weight == null) return editorError('Weight should be a number from 0 to 100.', 'weight');
    if (link && !/^https?:\/\/\S+$/i.test(link)) return editorError('Links need to start with https://', 'link');
    const release = parseDate(val('release')) ? val('release') : '';

    if (editor.source === 'mine') {
      const title = val('title');
      const due = val('due');
      if (!title) return editorError('Give it a title.', 'title');
      if (!parseDate(due)) return editorError('Pick a due date.', 'due');
      const time = toMin(val('time')) != null ? val('time') : '';
      const entry = { id: editor.id || newId(), title, module: val('module'), due, time, progress };
      if (weight != null) entry.weight = weight;
      if (link) entry.link = link;
      if (release) entry.release = release;
      const at = saved.coursework.findIndex((c) => c.id === entry.id);
      if (at >= 0) saved.coursework[at] = entry;
      else saved.coursework.push(entry);
    } else {
      const meta = { progress };
      if (val('module')) meta.module = val('module');
      if (weight != null) meta.weight = weight;
      if (link) meta.link = link;
      if (release) meta.release = release;
      saved.cwMeta[editor.id] = meta;
      if (editor.source === 'learn') {
        if (meta.module) saved.courseOf[editor.id] = meta.module;
        else delete saved.courseOf[editor.id];
      }
    }
    persist();
    closeEditor();
    render(false);
  }

  function deleteFromEditor(button) {
    if (!editor.confirmDelete) { // ask once more: this can't be undone
      editor.confirmDelete = true;
      button.textContent = 'Click again to delete';
      button.classList.add('confirm');
      return;
    }
    saved.coursework = saved.coursework.filter((c) => c.id !== editor.id);
    delete saved.submitted[editor.id];
    persist();
    closeEditor();
    render(false);
  }

  // ---------- add / edit a plan (interview, event, deadline...) ----------
  function openPlanEditor(id, type = 'plan') {
    closeEditor();
    const p = id ? (saved.plans || []).find((x) => x.id === id) : null;
    if (id && !p) return;
    const v = p || { type, title: '', date: '', start: '', end: '', where: '', notes: '' };
    const typeOptions = Object.entries(PLAN_TYPES)
      .map(([key, t]) => `<option value="${key}"${key === v.type ? ' selected' : ''}>${t.label}</option>`).join('');
    const noun = PLAN_TYPES[v.type] && v.type === 'interview' ? 'interview' : 'plan';
    const el = document.createElement('div');
    el.className = 'editor';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', p ? `Edit ${noun}` : `Add ${noun}`);
    el.innerHTML = `
      <header class="ed-head">
        <h2 class="card-title">${p ? `Edit ${noun}` : `Add ${noun}`}</h2>
        <span class="ed-msg">Press Enter to save, Esc to cancel.</span>
        <button type="button" class="ed-x" data-ed="cancel" aria-label="Close">✕</button>
      </header>
      <form class="ed-form" novalidate>
        <label class="f-time"><span>Type</span><select name="type">${typeOptions}</select></label>
        <label class="f-title"><span>Title</span><input name="title" maxlength="200" placeholder="${v.type === 'interview' ? 'e.g. Google - SWE intern, round 2' : 'e.g. Careers fair'}" value="${esc(v.title)}"></label>
        <label class="f-due"><span>Date</span><input type="date" name="date" value="${esc(v.date)}"></label>
        <label class="f-time"><span>Start</span><input type="time" name="start" value="${esc(v.start)}"></label>
        <label class="f-time"><span>End</span><input type="time" name="end" value="${esc(v.end)}"></label>
        <label class="f-where"><span>Where (place or video link)</span><input name="where" maxlength="300" placeholder="e.g. Main Library, or https://teams.microsoft.com/…" value="${esc(v.where)}"></label>
        <label class="f-notes"><span>Notes</span><input name="notes" maxlength="1000" placeholder="Prep notes, interviewer, what to bring…" value="${esc(v.notes)}"></label>
        <div class="f-actions">
          ${p ? '<button type="button" class="btn danger" data-ed="delete">Delete</button>' : ''}
          <button type="button" class="btn" data-ed="cancel">Cancel</button>
          <button type="submit" class="btn primary">${p ? 'Save' : 'Add'}</button>
        </div>
      </form>`;
    el.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); savePlan(); });
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ed]');
      if (!b) return;
      if (b.dataset.ed === 'cancel') closeEditor();
      else if (b.dataset.ed === 'delete') deletePlan(b);
    });
    panel.appendChild(el);
    editor = { id: p ? p.id : null, source: 'plan', el, confirmDelete: false };
    holdPanel(true);
    el.querySelector('input[name=title]').focus();
  }

  function savePlan() {
    const f = editor.el.querySelector('form');
    const val = (name) => String(f.elements[name] ? f.elements[name].value : '').trim();
    const title = val('title');
    const date = val('date');
    const start = toMin(val('start')) != null ? val('start') : '';
    const end = toMin(val('end')) != null ? val('end') : '';
    if (!title) return editorError('Give it a title.', 'title');
    if (!parseDate(date)) return editorError('Pick a date.', 'date');
    if (end && !start) return editorError('Add a start time too (or clear the end time).', 'start');
    if (start && end && toMin(end) <= toMin(start)) return editorError('The end time should be after the start.', 'end');
    const entry = {
      id: editor.id || `plan:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type: PLAN_TYPES[val('type')] ? val('type') : 'plan',
      title, date, start, end, where: val('where'), notes: val('notes'),
    };
    const at = saved.plans.findIndex((x) => x.id === entry.id);
    if (at >= 0) saved.plans[at] = entry;
    else saved.plans.push(entry);
    persist();
    closeEditor();
    render(false);
  }

  function deletePlan(button) {
    if (!editor.confirmDelete) { // ask once more: this can't be undone
      editor.confirmDelete = true;
      button.textContent = 'Click again to delete';
      button.classList.add('confirm');
      return;
    }
    saved.plans = saved.plans.filter((x) => x.id !== editor.id);
    persist();
    closeEditor();
    render(false);
  }

  // ---------- paste a schedule ----------
  // Copy a course schedule (Learn page, handbook, email), paste it, check the
  // list, add the lot. The reading itself is in importer.js.
  function modeSwitch(active) {
    return `<div class="seg" role="tablist">
      <button type="button" class="${active === 'one' ? 'on' : ''}" data-ed="one">One coursework</button>
      <button type="button" class="${active === 'paste' ? 'on' : ''}" data-ed="paste">Paste schedule</button>
    </div>`;
  }

  function courseOptions(selected, withMixed) {
    const opts = list('modules').filter((m) => !m.hidden || m.code === selected).map((m) => `<option value="${esc(m.code)}"${m.code === selected ? ' selected' : ''}>${esc(m.name || m.code)}</option>`).join('');
    return `<option value="">Choose a course…</option>${opts}${withMixed ? `<option value="*"${selected === '*' ? ' selected' : ''}>Several courses (match by name)</option>` : ''}`;
  }

  function openImport() {
    closeEditor();
    const el = document.createElement('div');
    el.className = 'editor importer';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Paste a schedule');
    panel.appendChild(el);
    editor = { id: null, source: 'import', el, rows: [] };
    holdPanel(true);
    showPasteStep();

    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ed],[data-imp]');
      if (!b) return;
      const action = b.dataset.ed || b.dataset.imp;
      if (action === 'cancel') closeEditor();
      else if (action === 'one') openEditor(null);
      else if (action === 'read') {
        const text = el.querySelector('.imp-paste').value;
        if (icsKind(text)) readIcs(text);
        else readPasted('', text);
      } else if (action === 'ics') pickIcs();
      else if (action === 'back') showPasteStep(editor.pastedText);
      else if (action === 'add') addImported();
    });
    el.addEventListener('change', (e) => {
      if (e.target.matches('.imp-all')) {
        el.querySelectorAll('.imp-row[data-i] input[type=checkbox]').forEach((c) => { c.checked = e.target.checked; });
      }
      if (e.target.matches('.imp-row input[type=checkbox]')) updateImportCount();
    });
  }

  function showPasteStep(previousText = '') {
    const el = editor.el;
    el.innerHTML = `
      <header class="ed-head">
        <h2 class="card-title">Add coursework</h2>
        ${modeSwitch('paste')}
        <span class="ed-msg">${PASTE_HINT}</span>
        <button type="button" class="ed-x" data-ed="cancel" aria-label="Close">✕</button>
      </header>
      <div class="imp-paste-wrap">
        <textarea class="imp-paste" spellcheck="false" placeholder="Paste a schedule copied from a course page, handbook or email - tables work best.&#10;Plain text works too: one coursework per line with its dates, e.g.  CW1 released Mon 5 Oct, due Fri 23 Oct 12:00 (20%)&#10;Got a calendar? Use Import .ics file, drop the file here, or paste its link (https:// or webcal://).">${esc(previousText)}</textarea>
        <div class="imp-actions">
          <button type="button" class="btn primary" data-imp="read">Find coursework</button>
          <button type="button" class="btn" data-imp="ics" title="A module's iCalendar file (.ics)">Import .ics file</button>
          <input type="file" class="imp-file" accept=".ics,.ical,.ifb,.icalendar,text/calendar" hidden>
        </div>
      </div>`;
    const box = el.querySelector('.imp-paste');
    box.addEventListener('paste', (e) => {
      const html = e.clipboardData ? e.clipboardData.getData('text/html') : '';
      const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';
      const file = icsFileIn(e.clipboardData);
      if (file) { e.preventDefault(); readIcsFile(file); return; }
      if (!html && !text) return; // let the browser handle it
      e.preventDefault();
      box.value = text;
      if (icsKind(text)) readIcs(text);
      else readPasted(html, text);
    });
    const fileInput = el.querySelector('.imp-file');
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) readIcsFile(fileInput.files[0]);
      fileInput.value = '';
    });
    // Drop a .ics file on the box.
    const wrap = el.querySelector('.imp-paste-wrap');
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); wrap.classList.add('drop'); });
    wrap.addEventListener('dragleave', (e) => { if (!wrap.contains(e.relatedTarget)) wrap.classList.remove('drop'); });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      wrap.classList.remove('drop');
      const file = icsFileIn(e.dataTransfer);
      if (file) readIcsFile(file);
      else if (e.dataTransfer && e.dataTransfer.files.length) importMessage("That isn't a .ics file. Drop a module's calendar file (ending in .ics).", true);
      else {
        const text = e.dataTransfer ? e.dataTransfer.getData('text/plain') : '';
        if (text) { box.value = text; if (icsKind(text)) readIcs(text); else readPasted('', text); }
      }
    });
    box.focus();
  }

  function importMessage(text, isError) {
    const msg = editor && editor.el.querySelector('.ed-msg');
    if (!msg) return;
    msg.textContent = text;
    msg.classList.toggle('err', !!isError);
  }

  // ---- .ics calendars (a file, its text, or a link) ----
  // 'text' for the contents of a .ics file, 'link' for a calendar address.
  function icsKind(text) {
    const t = String(text || '').trim();
    if (/^﻿?BEGIN:VCALENDAR/i.test(t)) return 'text';
    if (/^(webcal|https?):\/\/\S+$/i.test(t)) return 'link'; // a lone link: try it as a calendar
    return '';
  }

  function icsFileIn(transfer) {
    const files = transfer && transfer.files ? [...transfer.files] : [];
    return files.find((f) => /\.(ics|ical|icalendar|ifb)$/i.test(f.name) || f.type === 'text/calendar') || null;
  }

  function readIcsFile(file) {
    if (file.size > 10 * 1024 * 1024) return importMessage('That file is too big to be a module calendar (over 10 MB).', true);
    const reader = new FileReader();
    reader.onload = () => readIcs(String(reader.result || ''), file.name);
    reader.onerror = () => importMessage("Couldn't open that file.", true);
    reader.readAsText(file);
  }

  function readIcs(text, fileName = '') {
    const isLink = icsKind(text) === 'link';
    loadIcs(isLink ? 'Downloading the calendar…' : 'Reading the calendar…',
      (api) => (isLink ? api.fetch_ics(text.trim()) : api.parse_ics(text)),
      isLink ? text.trim() : '', fileName);
  }

  // Import .ics file: the system's Open dialog comes from the desktop app.
  function pickIcs() {
    const api = window.pywebview && window.pywebview.api;
    if (!api || !api.pick_ics) { editor.el.querySelector('.imp-file').click(); return; } // browser preview
    loadIcs('Choose a calendar file…', async (a) => {
      const picked = await a.pick_ics();      if (!picked || !picked.path) return picked;
      importMessage('Reading the calendar…');
      return a.read_ics_file(picked.path);
    }, '', '');
  }

  async function loadIcs(busyText, call, linkText, fileName) {
    const api = window.pywebview && window.pywebview.api;
    if (!api || !api.parse_ics) return importMessage('Calendar files can only be read in the desktop dashboard.', true);
    const ticket = (editor.icsTicket = (editor.icsTicket || 0) + 1);
    importMessage(busyText);
    let res;
    try {
      res = await call(api);
    } catch (err) {
      report(err);
      res = { error: "Couldn't read that calendar." };
    }
    if (!editor || editor.icsTicket !== ticket || !editor.el.querySelector('.imp-paste')) return; // closed or moved on
    if (res && res.cancelled) return importMessage(PASTE_HINT);
    if (!res || res.error) return importMessage((res && res.error) || "Couldn't read that calendar.", true);
    fileName = fileName || res.file || '';
    const { rows, classes } = window.ScheduleImport.fromEvents(res.events || [], { today: startOfDay(now()) });
    editor.pastedText = linkText;
    if (!rows.length) {
      return importMessage(classes
        ? `That calendar only has classes (${classes}), no deadlines.`
        : 'No upcoming events in that calendar.', true);
    }
    const name = String(res.name || '').trim() || fileName.replace(/\.[a-z]+$/i, '');
    const notes = [classes ? `Left out ${classes} class${classes === 1 ? '' : 'es'}.` : '',
      rows.some((r) => r.past) ? 'Past deadlines are unticked.' : ''].filter(Boolean).join(' ');
    showRows(rows, { courseHint: matchModule(res.name, fileName), from: name, notes });
  }

  function readPasted(html, text) {
    const today = startOfDay(now());
    const sem = semesterInfo(today);
    const rows = window.ScheduleImport.parse(html, text, { today, semesterStart: sem ? sem.start : null });
    editor.pastedText = text;
    if (!rows.length) {
      importMessage('No dates found in that. Copy the part of the page with the deadlines, or type one coursework per line.', true);
      return;
    }
    showRows(rows, {});
  }

  function showRows(rows, { courseHint = '', from = '', notes = '' }) {
    // Already on the dashboard (same title and due date)? Leave those unticked.
    // ("CW1 Network exploits" matches "Network exploits" due the same day.)
    const existing = allCoursework().filter((c) => c.dueD).map((c) => ({ t: normTitle(c.title), due: iso(c.dueD) }));
    rows.forEach((r) => {
      const t = normTitle(r.title);
      r.duplicate = !!t && existing.some((c) => c.due === r.due && c.t
        && (c.t === t || ` ${t} `.includes(` ${c.t} `) || ` ${c.t} `.includes(` ${t} `)));
      r.checked = r.likely && !r.duplicate;
      r.module = matchModule(r.title, r.text) || courseHint;
    });
    // Guess the course from what the rows mention (if they all agree), or
    // from the calendar's name.
    const found = [...new Set(rows.map((r) => r.module).filter(Boolean))];
    editor.course = found.length === 1 ? found[0] : found.length > 1 ? '*' : '';
    editor.rows = rows;
    editor.from = from;
    editor.notes = notes;
    showPreviewStep();
  }

  function showPreviewStep() {
    const el = editor.el;
    const rows = editor.rows;
    const rowHtml = rows.map((r, i) => {
      const notes = [
        r.duplicate ? 'Already on your dashboard' : '',
        r.past ? 'This deadline has passed' : '',
        !r.due ? 'No due date found - add one to include it' : '',
        r.approx ? 'Worked out from a week number - please check the date' : '',
      ].filter(Boolean);
      return `<div class="imp-row${r.duplicate ? ' dup' : ''}${r.past ? ' past' : ''}" data-i="${i}" title="${esc([r.text, ...notes].join('\n'))}">
        <input type="checkbox" aria-label="Include" ${r.checked ? 'checked' : ''}>
        <input name="title" maxlength="200" value="${esc(r.title)}">
        <input type="date" name="release" value="${esc(r.release)}">
        <input type="date" name="due" value="${esc(r.due)}" class="${!r.due || r.approx ? 'check-me' : ''}">
        <input type="time" name="time" value="${esc(r.time)}">
        <input type="number" name="weight" min="0" max="100" step="1" value="${r.weight ?? ''}">
      </div>`;
    }).join('');
    el.innerHTML = `
      <header class="ed-head">
        <h2 class="card-title">Add coursework</h2>
        ${modeSwitch('paste')}
        <label class="imp-course">Course <select data-imp-course>${courseOptions(editor.course, true)}</select></label>
        <span class="ed-msg" title="${esc(editor.from ? `From ${editor.from}` : '')}">Found ${rows.length}${editor.from ? ` in ${esc(editor.from)}` : ''}. Untick anything that isn't coursework.${editor.notes ? ` ${esc(editor.notes)}` : ''}</span>
        <button type="button" class="btn" data-imp="back">Back</button>
        <button type="button" class="btn primary" data-imp="add">Add</button>
        <button type="button" class="ed-x" data-ed="cancel" aria-label="Close">✕</button>
      </header>
      <div class="imp-list">
        <div class="imp-row imp-head"><input type="checkbox" class="imp-all" aria-label="Tick all" title="Tick all / none"><span>Title</span><span>Released</span><span>Due</span><span>Time</span><span>Weight %</span></div>
        ${rowHtml}
      </div>`;
    updateImportCount();
  }

  function updateImportCount() {
    const boxes = editor.el.querySelectorAll('.imp-row[data-i] input[type=checkbox]');
    const n = [...boxes].filter((c) => c.checked).length;
    const all = editor.el.querySelector('.imp-all');
    if (all) {
      all.checked = n > 0 && n === boxes.length;
      all.indeterminate = n > 0 && n < boxes.length;
    }
    const add = editor.el.querySelector('[data-imp=add]');
    add.textContent = n ? `Add ${n}` : 'Add';
    add.disabled = !n;
  }

  function addImported() {
    const el = editor.el;
    const msg = el.querySelector('.ed-msg');
    const course = el.querySelector('[data-imp-course]').value;
    const fail = (text, input) => {
      msg.textContent = text;
      msg.classList.add('err');
      if (input) input.focus();
    };
    if (!course) return fail('Choose which course these are for (or "Several courses").', el.querySelector('[data-imp-course]'));
    const entries = [];
    for (const row of el.querySelectorAll('.imp-row[data-i]')) {
      if (!row.querySelector('input[type=checkbox]').checked) continue;
      const get = (name) => String(row.querySelector(`[name=${name}]`).value || '').trim();
      const title = get('title');
      if (!title) return fail('One of the ticked rows has no title.', row.querySelector('[name=title]'));
      if (!parseDate(get('due'))) return fail(`"${title}" needs a due date.`, row.querySelector('[name=due]'));
      const source = editor.rows[+row.dataset.i];
      const entry = {
        id: `${newId()}${entries.length}`, title, due: get('due'), progress: 0,
        module: course === '*' ? matchModule(title, source.text) || source.module || '' : course,
        time: toMin(get('time')) != null ? get('time') : '',
      };
      if (parseDate(get('release'))) entry.release = get('release');
      const weight = clampPct(get('weight'));
      if (weight != null) entry.weight = weight;
      entries.push(entry);
    }
    if (!entries.length) return fail('Tick at least one row to add.');
    saved.coursework.push(...entries);
    persist();
    closeEditor();
    render(false);
  }

  // A file dropped anywhere else mustn't replace the dashboard with that file.
  ['dragover', 'drop'].forEach((type) => document.addEventListener(type, (e) => {
    if (!e.defaultPrevented) e.preventDefault();
  }));

  // Esc closes the form first (and only the form).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editor) {
      const quick = editor.source === 'quick';
      closeEditor();
      if (quick) hideIfQuick();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  if (panel) panel.addEventListener('click', (ev) => {
    if (ev.target.closest('.editor')) return; // the form handles its own clicks
    if (ev.target.closest('[data-open-settings]')) {
      if (apiReady() && typeof window.pywebview.api.open_settings === 'function') window.pywebview.api.open_settings();
      return;
    }
    if (ev.target.closest('[data-add-cw]')) { openEditor(null); return; }
    const linkBtn = ev.target.closest('[data-link]');
    if (linkBtn) { openLink(linkBtn.dataset.link); return; }

    // Uni / Life switch
    const viewBtn = ev.target.closest('[data-view]');
    if (viewBtn) {
      if (saved.view !== viewBtn.dataset.view) {
        saved.view = ['life', 'study'].includes(viewBtn.dataset.view) ? viewBtn.dataset.view : 'uni';
        persist();
        render(true);
      }
      return;
    }
    // Plans: add, or click one (in either view) to edit it
    const addPlan = ev.target.closest('[data-add-plan]');
    if (addPlan) { openPlanEditor(null, addPlan.dataset.addPlan); return; }
    const planEl = ev.target.closest('[data-plan]');
    if (planEl) { openPlanEditor(planEl.dataset.plan); return; }

    // Course picker for Learn deadlines
    const pick = ev.target.closest('button.pick');
    if (pick) {
      pickingFor = pick.dataset.pick;
      render(false);
      return;
    }
    const chip = ev.target.closest('button.pick-chip');
    if (chip) {
      if (chip.dataset.pickFor) {
        saved.courseOf[chip.dataset.pickFor] = chip.dataset.code;
        persist();
      }
      pickingFor = null;
      render(false);
      return;
    }

    const btn = ev.target.closest('button.check');
    if (!btn) {
      // Clicking a coursework row opens it for editing.
      const row = ev.target.closest('[data-edit]');
      if (row) openEditor(row.dataset.edit);
      return;
    }
    if (btn.dataset.task != null) {
      const id = btn.dataset.task;
      const t = allTasks().find((x) => x.id === id);
      if (!t) return;
      saved.done[id] = !t.done;
      recentlyTicked.add(`t:${id}`);
    } else if (btn.dataset.cw != null) {
      const id = btn.dataset.cw;
      const c = allCoursework().find((x) => x.id === id);
      if (!c) return;
      saved.submitted[id] = !c.submitted;
      recentlyTicked.add(`c:${id}`);
    }
    persist();
    render(false);
  });

  // ---------- Study: now playing + focus timer ----------
  // The desktop app reads whatever is playing (Spotify, or any app in Windows'
  // media pop-up) and sends it here; the buttons go back to that app. You pick
  // the music in Spotify itself.
  const MP_ICONS = {
    previous: '<path d="M6.5 5.5v13"/><path class="f" d="M18.5 5.8v12.4a.8.8 0 0 1-1.25.66L9 12.66a.8.8 0 0 1 0-1.32l8.25-6.2a.8.8 0 0 1 1.25.66z"/>',
    next: '<path d="M17.5 5.5v13"/><path class="f" d="M5.5 5.8v12.4a.8.8 0 0 0 1.25.66L15 12.66a.8.8 0 0 0 0-1.32L6.75 5.14a.8.8 0 0 0-1.25.66z"/>',
    play: '<path class="f" d="M8 5.2v13.6a1 1 0 0 0 1.52.85l10.9-6.8a1 1 0 0 0 0-1.7L9.52 4.35A1 1 0 0 0 8 5.2z"/>',
    pause: '<rect class="f" x="6.5" y="5" width="3.8" height="14" rx="1.1"/><rect class="f" x="13.7" y="5" width="3.8" height="14" rx="1.1"/>',
    note: '<path d="M9 18V5.5l11-2v12.5"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
    skip: '<path d="M5 12h12M13 7l5 5-5 5"/>',
    stop: '<rect class="f" x="6.5" y="6.5" width="11" height="11" rx="2"/>',
  };
  const mpIcon = (name) => `<svg class="mp-i" viewBox="0 0 24 24" aria-hidden="true">${MP_ICONS[name]}</svg>`;
  const EQ = '<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
  let mediaState = null; // { available, error, spotifyInstalled, now, focus } from the desktop app
  const tintCache = new Map(); // album art -> a colour picked from it

  const study = () => (data && data.study && typeof data.study === 'object' ? data.study : {});
  // The small timer in the corner of the screen: this session's choice while the
  // timer runs, otherwise your setting (Settings → Study & look).
  function miniOn() {
    const f = mediaState && mediaState.focus;
    if (f && f.phase) return f.mini !== false;
    const s = settings && settings.study && settings.study.miniTimer;
    return (s != null ? s : study().miniTimer) !== false;
  }
  const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt; };
  function fmtClock(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  // Where the song is now: the app reports a position and when it measured it.
  function mediaPosition(n) {
    if (!n) return 0;
    const pos = n.status === 'playing' ? n.position + (Date.now() - n.updatedAt) / 1000 : n.position;
    return n.duration ? Math.min(n.duration, Math.max(0, pos)) : 0;
  }
  // Compact time for small spaces: "50m", "1h15", "2h".
  const shortDur = (m) => (m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? pad(m % 60) : ''}`);
  const focusLeft = (f) => (f && f.phase ? Math.max(0, (f.endsAt - Date.now()) / 1000) : 0);
  const focusOn = () => !!(mediaState && mediaState.focus && mediaState.focus.phase);
  const musicPlaying = () => !!(mediaState && mediaState.now && mediaState.now.status === 'playing');

  // A colour from the album art (light or dark enough for the theme), for the
  // progress bar, the play button and the glow behind the art.
  function tintFor(now) {
    if (!now || !now.art) return now && now.spotify ? '#1ed760' : '';
    const key = `${now.artId}|${document.documentElement.dataset.theme}`;
    if (tintCache.has(key)) return tintCache.get(key);
    tintCache.set(key, '');
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 12;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, 12, 12);
        const px = ctx.getImageData(0, 0, 12, 12).data;
        let r = 0, g = 0, b = 0, w = 0;
        for (let i = 0; i < px.length; i += 4) {
          const mx = Math.max(px[i], px[i + 1], px[i + 2]), mn = Math.min(px[i], px[i + 1], px[i + 2]);
          const weight = 0.05 + (mx - mn) / 255; // colourful pixels count more than grey ones
          r += px[i] * weight; g += px[i + 1] * weight; b += px[i + 2] * weight; w += weight;
        }
        const [h, s] = rgbToHsl(r / w, g / w, b / w);
        const light = ['windows-light', 'sand'].includes(document.documentElement.dataset.theme);
        tintCache.set(key, `hsl(${Math.round(h)} ${Math.round(Math.max(s, 0.35) * 100)}% ${light ? 38 : 64}%)`);
        if (saved.view === 'study' && mediaState && mediaState.now && mediaState.now.artId === now.artId) renderPlayer();
      } catch (err) { report(err); }
    };
    img.src = now.art;
    return '';
  }
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  }

  // The Study button: a countdown while the timer runs, dancing bars while music plays.
  function studyBadge() {
    if (saved.view === 'study' || !mediaState) return '';
    const f = mediaState.focus;
    if (f && f.phase) return `<span class="vbadge ft-badge ${f.phase}" data-focus-left title="${f.phase === 'focus' ? 'Focus' : 'Break'} time left">${fmtClock(focusLeft(f))}</span>`;
    return musicPlaying() ? `<span class="vbadge eq-badge" title="Music playing">${EQ}</span>` : '';
  }

  function renderStudyOverview(n, today, tasks, cws) {
    const h = n.getHours();
    const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const name = String(data.name ?? '').trim();
    const f = mediaState && mediaState.focus;
    const now = mediaState && mediaState.now;
    const line = f && f.phase === 'focus' ? `Focusing · ${Math.ceil(focusLeft(f) / 60)} min left`
      : f && f.phase === 'break' ? `On a break · ${Math.ceil(focusLeft(f) / 60)} min left`
        : now && now.title ? `♪ ${now.title}${now.artist ? ` · ${now.artist}` : ''}`
          : 'Pick a timer, put some music on';
    const goal = goalMinutes();
    const mins = Number(focusHistory()[iso(focusToday())]) || 0;
    const left = deadlineItems(today, tasks, cws).filter((t) => !t.done && t.dueD && t.dueD >= today && daysBetween(today, t.dueD) < 7);
    const next = left.sort(byDue)[0];
    els.overview.innerHTML = `
      <div>
        <div class="greet"><span>${esc(part)}${name ? `, ${esc(name)}` : ''}</span>${gearButton()}</div>
        <div class="date-row"><div class="date">${dateHtml(today)}</div>${viewSwitch(today)}</div>
      </div>
      <div class="semline life-line" title="${esc(line)}"><span>${esc(line)}</span></div>
      <div class="stats">
        <div class="stat stack${goal && mins >= goal ? ' goal-met' : ''}" title="${esc(`${mins ? fmtDur(mins) : 'No time'} focused today${goal ? ` · daily goal ${fmtDur(goal)} (${Math.min(100, Math.round((mins / goal) * 100))}%)` : ''}${f && f.rounds ? ` · ${count(f.rounds, 'session', 'sessions')}` : ''}`)}"><b>${esc(shortDur(mins))}</b><span>Focused${goal ? (mins >= goal ? ' ✓' : ` · ${Math.round((mins / goal) * 100)}%`) : ''}</span>${goal ? `<i class="stat-bar" style="--p:${Math.min(100, Math.round((mins / goal) * 100))}%"></i>` : ''}</div>
        <div class="stat" title="${esc(next ? `Next: ${next.title}` : '')}"><b>${left.length}</b><span>Due</span><small>${next ? `next ${esc(daysBetween(today, next.dueD) === 0 ? 'today' : DAY_KEYS[next.dueD.getDay()])}` : 'this week'}</small></div>
      </div>`;
  }

  function renderPlayer() {
    const card = els.media;
    if (!card) return;
    const st = mediaState;
    const now = st && st.now;
    const playing = !!now && now.status === 'playing';
    const tint = tintFor(now);
    if (tint) card.style.setProperty('--mp', tint);
    else card.style.removeProperty('--mp');
    card.classList.toggle('playing', playing);

    const badge = now ? `<span class="mp-src${now.spotify ? ' sp' : ''}" title="Playing in ${esc(now.app)}">${esc(now.app)}</span>` : '';
    const header = `<header class="card-head">${playing ? EQ : mpIcon('note')}<h2 class="card-title">Now playing</h2><span class="card-meta"></span>${badge}</header>`;
    const idle = (line, button) => `<div class="mp-wide idle"><div class="mp-art">${mpIcon('note')}</div>
      <div class="mp-info"><div class="mp-title">Nothing playing</div><div class="mp-artist">${esc(line)}</div>${button}</div></div>`;
    let body;
    if (!st) {
      body = idle('Play something in Spotify and it shows up here (in the desktop app).', '');
    } else if (!st.available) {
      body = `<div class="note warn" title="${esc(st.error)}">${esc(st.error)}</div>`;
    } else if (!now) {
      body = idle('Play something in Spotify (or anywhere) and it shows up here.',
        `<button type="button" class="mp-open" data-sp-open>${st.spotifyInstalled ? 'Open Spotify' : 'Open the Spotify web player'}</button>`);
    } else {
      const pos = mediaPosition(now);
      const pct = now.duration ? (pos / now.duration) * 100 : 0;
      body = `
        <div class="mp-wide">
          <div class="mp-art">${now.art ? `<img src="${now.art}" alt="">` : mpIcon('note')}</div>
          <div class="mp-info">
            <div class="mp-title" title="${esc(now.title)}">${esc(now.title || 'Unknown title')}</div>
            <div class="mp-artist" title="${esc(now.artist)}">${esc(now.artist || now.app)}</div>
            ${now.album ? `<div class="mp-album" title="${esc(now.album)}">${esc(now.album)}</div>` : ''}
            ${now.duration ? `<div class="mp-seek${now.canSeek ? ' can' : ''}">
              <span class="mp-t" data-mp-pos>${fmtClock(pos)}</span>
              <div class="mp-bar" data-mp-seek title="${now.canSeek ? 'Click to jump' : ''}"><div class="mp-fill" data-mp-fill style="width:${pct.toFixed(2)}%"></div></div>
              <span class="mp-t">${fmtClock(now.duration)}</span></div>` : ''}
            <div class="mp-ctl">
              <button type="button" class="mp-btn" data-mp="previous" title="Previous"${now.canPrevious ? '' : ' disabled'}>${mpIcon('previous')}</button>
              <button type="button" class="mp-btn play" data-mp="toggle" title="${playing ? 'Pause' : 'Play'}"${now.canToggle ? '' : ' disabled'}>${mpIcon(playing ? 'pause' : 'play')}</button>
              <button type="button" class="mp-btn" data-mp="next" title="Next"${now.canNext ? '' : ' disabled'}>${mpIcon('next')}</button>
            </div>
          </div>
        </div>`;
    }
    // The blurred cover sits behind the whole card, sounds row included.
    const bg = now && now.art ? `<div class="mp-bg" style="background-image:url('${now.art}')"></div>` : '';
    card.innerHTML = `${bg}${header}<div class="mp-body">${body}</div>${ambientRow()}`;
  }

  // Focus lengths to pick from: yours (study.focusMinutes) plus 25, 50 and 90.
  function focusPresets() {
    const s = study();
    const mine = { f: clampInt(s.focusMinutes, 1, 180, 25), b: clampInt(s.breakMinutes, 1, 60, 5) };
    const list = [mine];
    for (const [f, b] of [[25, 5], [50, 10], [90, 15]]) if (f !== mine.f) list.push({ f, b });
    return list.sort((a, b) => a.f - b.f);
  }
  let focusChoice = 0; // minutes picked in the timer card (remembered on this PC)
  try { focusChoice = Number(localStorage.getItem('student-dashboard-focus')) || 0; } catch (err) { /* private mode */ }
  function chosenPreset() {
    const list = focusPresets();
    return list.find((p) => p.f === focusChoice) || list.find((p) => p.f === clampInt(study().focusMinutes, 1, 180, 25)) || list[0];
  }

  function renderTimer() {
    const st = mediaState;
    const f = st ? st.focus : null;
    const running = !!(f && f.phase);
    const preset = chosenPreset();
    const left = running ? focusLeft(f) : preset.f * 60;
    const frac = running && f.length ? Math.min(1, Math.max(0, 1 - left / f.length)) : 0;
    const label = !running ? 'Ready' : f.phase === 'focus' ? 'Focus' : 'Break';
    const meta = f && f.rounds ? `${count(f.rounds, 'session', 'sessions')} · ${fmtDur(f.minutes)}` : '';
    const ring = `<div class="ft-ring ${running ? f.phase : 'idle'}">
        <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="44"/><circle class="ft-arc" cx="50" cy="50" r="44" pathLength="100" style="stroke-dashoffset:${(100 - frac * 100).toFixed(2)}"/></svg>
        <div class="ft-mid"><b${running ? ' data-focus-left' : ''}>${fmtClock(left)}</b><span>${label}</span></div>
      </div>`;
    let side;
    if (!apiReady() || !st) {
      side = '<p class="ft-hint">The focus timer works in the desktop app.</p>';
    } else if (!running) {
      const targets = studyTargets(startOfDay(now()));
      const options = targets.map((c) => `<option value="${esc(c.id)}"${c.id === focusSubject ? ' selected' : ''}>${esc(c.title)}${c.module ? ` (${esc(c.module)})` : ''}</option>`).join('');
      side = `<div class="seg ft-len" role="group" aria-label="Focus length">${focusPresets().map((p) => `<button type="button" data-focus-len="${p.f}" class="${p.f === preset.f ? 'on' : ''}" title="${p.f} min focus, ${p.b} min break">${p.f}</button>`).join('')}</div>
        ${targets.length ? `<select class="ft-subject" data-focus-subject aria-label="Working on"><option value="">Working on… (optional)</option>${options}</select>` : ''}
        <button type="button" class="btn primary ft-go" data-focus="start">Start focus</button>
        <p class="ft-hint">${preset.f} min focus, ${preset.b} min break, again and again until you stop.</p>`;
    } else {
      const ends = new Date(f.endsAt);
      const on = f.subject && f.subject.title && f.phase === 'focus' ? `<p class="ft-on" title="${esc(f.subject.title)}">On <b>${esc(f.subject.title)}</b></p>` : '';
      side = `${on}<p class="ft-hint">${f.phase === 'focus' ? 'Break at' : 'Next focus at'} <b>${pad(ends.getHours())}:${pad(ends.getMinutes())}</b></p>
        <div class="ft-btns">
          <button type="button" class="btn" data-focus="skip" title="${f.phase === 'focus' ? 'Start the break now' : 'End the break now'}">${mpIcon('skip')}${f.phase === 'focus' ? 'Break now' : 'End break'}</button>
          <button type="button" class="btn" data-focus="stop" title="Stop the timer">${mpIcon('stop')}Stop</button>
        </div>`;
    }
    const mini = miniOn();
    const miniBtn = apiReady() && st ? `<button type="button" class="head-btn ft-mini${mini ? ' on' : ''}" data-mini-toggle role="switch" aria-checked="${mini}" title="${mini ? 'Showing' : 'Not showing'} a small timer in the corner of your screen while it runs. Click to ${mini ? 'hide' : 'show'} it."><i></i><span>On screen</span></button>` : '';
    els.schedule.innerHTML = head('timer', 'Focus timer', meta, null, miniBtn) + `<div class="card-body ft">${ring}<div class="ft-side">${side}</div></div>`;
  }

  // Minutes focused each day this week, as bars.
  function renderFocusWeek(today) {
    const hist = (mediaState && mediaState.focus && mediaState.focus.history) || {};
    const monday = addDays(today, -((today.getDay() + 6) % 7));
    const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((d) => ({ d, m: Number(hist[iso(d)]) || 0 }));
    const total = days.reduce((s, x) => s + x.m, 0);
    const goal = goalMinutes();
    const streak = focusStreak();
    const top = Math.max(60, goal * 1.15, ...days.map((x) => x.m));
    const cols = days.map(({ d, m }) => {
      const isToday = daysBetween(today, d) === 0;
      return `<div class="fw-day${isToday ? ' today' : ''}${d > today ? ' future' : ''}${goal && m >= goal ? ' met' : ''}" title="${esc(`${DAY_LONG[d.getDay()]}: ${m ? fmtDur(m) : 'no focus time'}${goal && m >= goal ? ' (goal met)' : ''}`)}">
        <span class="fw-val">${m ? esc(shortDur(m)) : ''}</span>
        <div class="fw-track" style="--goal:${goal ? ((goal / top) * 100).toFixed(1) : -10}%"><i style="height:${((m / top) * 100).toFixed(1)}%"></i></div>
        <span class="fw-key">${DAY_KEYS[d.getDay()]}</span></div>`;
    }).join('');
    const meta = [streak ? `${streak}-day streak` : '', total ? `${fmtDur(total)} total` : ''].filter(Boolean).join(' · ');
    els.week.innerHTML = head('bars', 'Focus this week', meta)
      + `<div class="card-body fw">${cols}</div>`;
  }

  // Between updates from the app the progress bar and timers move by themselves
  // (only while the panel is open).
  function mediaTick() {
    if (parked || !mediaState) return;
    const now = mediaState.now;
    if (saved.view === 'study' && now && now.status === 'playing' && now.duration) {
      const pos = mediaPosition(now);
      const t = document.querySelector('[data-mp-pos]');
      const fill = document.querySelector('[data-mp-fill]');
      if (t) t.textContent = fmtClock(pos);
      if (fill) fill.style.width = `${((pos / now.duration) * 100).toFixed(2)}%`;
    }
    const f = mediaState.focus;
    if (f && f.phase) {
      const left = focusLeft(f);
      document.querySelectorAll('[data-focus-left]').forEach((el) => { el.textContent = fmtClock(left); });
      const arc = document.querySelector('.ft-arc');
      if (arc && f.length) arc.style.strokeDashoffset = (100 - Math.min(1, 1 - left / f.length) * 100).toFixed(2);
    }
  }
  setInterval(mediaTick, 1000);

  window.onMediaUpdated = (snapshot) => {
    const before = mediaState && mediaState.focus ? mediaState.focus.phase : '';
    if (snapshot && typeof snapshot === 'object') mediaState = snapshot;
    if (data && !SUMMARY) render(false);
  };
  async function loadMedia() {
    if (!(apiReady() && typeof window.pywebview.api.get_media === 'function')) return;
    try { mediaState = await window.pywebview.api.get_media(); } catch (err) { report(err); }
  }

  function studyClick(ev) {
    if (ev.target.closest('.editor')) return;
    const api = apiReady() ? window.pywebview.api : null;
    const b = ev.target.closest('[data-mp], [data-mp-seek], [data-sp-open], [data-focus], [data-focus-len], [data-ambient], [data-mini-toggle]');
    if (!b || b.disabled) return;
    const now = mediaState && mediaState.now;
    if (b.dataset.mp && api && now) {
      if (b.dataset.mp === 'toggle') { // looks instant; the app confirms a moment later
        now.position = mediaPosition(now);
        now.updatedAt = Date.now();
        now.status = now.status === 'playing' ? 'paused' : 'playing';
        render(false);
      }
      Promise.resolve(api.media_command(b.dataset.mp)).catch(report);
    } else if (b.dataset.mpSeek != null && api && now && now.canSeek && now.duration) {
      const r = b.getBoundingClientRect();
      const to = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)) * now.duration;
      now.position = to;
      now.updatedAt = Date.now();
      mediaTick();
      Promise.resolve(api.media_command('seek', to)).catch(report);
    } else if (b.dataset.spOpen != null) {
      if (api) Promise.resolve(api.open_spotify()).catch(report);
      else window.open('https://open.spotify.com/', '_blank', 'noopener');
    } else if (b.dataset.miniToggle != null && api) {
      const on = !miniOn();
      // Looks instant; the app shows or hides the corner timer and remembers it.
      if (mediaState && mediaState.focus) mediaState.focus.mini = on;
      settings = { ...(settings || {}), study: { ...((settings && settings.study) || {}), miniTimer: on } };
      renderTimer();
      Promise.resolve(api.set_mini_timer(on)).catch(report);
    } else if (b.dataset.focusLen) {
      focusChoice = Number(b.dataset.focusLen) || 0;
      try { localStorage.setItem('student-dashboard-focus', String(focusChoice)); } catch (err) { /* private mode */ }
      renderTimer();
    } else if (b.dataset.ambient) {
      if (Ambient.current === b.dataset.ambient) Ambient.stop();
      else Ambient.play(b.dataset.ambient);
      renderPlayer();
    } else if (b.dataset.focus && api) {
      const p = chosenPreset();
      const target = b.dataset.focus === 'start' && focusSubject ? allCoursework().find((c) => c.id === focusSubject) : null;
      Promise.resolve(api.focus(b.dataset.focus, p.f, p.b, false,
        target ? { id: target.id, title: target.title } : null, miniOn(), goalMinutes())).catch(report);
    }
  }
  if (panel) panel.addEventListener('click', studyClick);
  // The "Working on" list and the sound volume.
  if (panel) panel.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.matches('[data-focus-subject]')) {
      focusSubject = t.value;
      try { localStorage.setItem('student-dashboard-focus-subject', focusSubject); } catch (err) { /* private mode */ }
    } else if (t.matches('[data-ambient-volume]')) Ambient.setVolume(t.value);
  });

  // ---------- Study extras: focus subject, daily goal, ambient sounds ----------
  // Which coursework the next focus session is for (remembered on this PC).
  let focusSubject = '';
  try { focusSubject = localStorage.getItem('student-dashboard-focus-subject') || ''; } catch (err) { /* private mode */ }
  function studyTargets(today) {
    const list_ = allCoursework().filter((c) => !c.submitted && (!c.dueD || daysBetween(today, c.dueD) >= -1)).sort(byDue);
    return list_.slice(0, 25);
  }
  // "3h 20m focused" for a coursework you've timed.
  function focusSpent(id) {
    const item = mediaState && mediaState.focus && (mediaState.focus.byItem || {})[id];
    return item && item.minutes ? `${fmtDur(item.minutes)} focused` : '';
  }

  // Daily focus goal and streak (days in a row the goal was met).
  const goalMinutes = () => clampInt(study().dailyGoalMinutes, 0, 1440, 120);
  const focusHistory = () => (mediaState && mediaState.focus && mediaState.focus.history) || {};
  const focusToday = () => startOfDay(new Date(Date.now() - 4 * 3600000)); // a focus day starts at 4am
  function focusStreak() {
    const goal = goalMinutes();
    const hist = focusHistory();
    if (!goal) return 0;
    let d = focusToday();
    if ((hist[iso(d)] || 0) < goal) d = addDays(d, -1); // today isn't over yet
    let n = 0;
    while ((hist[iso(d)] || 0) >= goal && n < 400) { n++; d = addDays(d, -1); }
    return n;
  }

  // Ambient sounds: real recordings (sounds/*.ogg, CC0 from BigSoundBank.com,
  // cut into seamless loops) played with Web Audio, plus brown noise made on
  // the spot. Web Audio doesn't show up in Windows' media controls, so the
  // player keeps showing your music, not these.
  const Ambient = (() => {
    const NAMES = { rain: 'Rain', waves: 'Waves', fire: 'Fire', cafe: 'Cafe', brown: 'Noise' };
    const RECORDED = new Set(['rain', 'waves', 'fire', 'cafe']);
    let ctx = null, master = null, current = '', stopFns = [], volume = 0.5;
    const buffers = new Map(); // name -> decoded AudioBuffer (loaded once)
    try { volume = Number(localStorage.getItem('student-dashboard-ambient-volume') || 0.5); } catch (err) { /* private mode */ }

    function gain(v) { const g = ctx.createGain(); g.gain.value = v; return g; }
    function loop(buf, offset = 0) {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.start(0, offset);
      stopFns.push(() => s.stop());
      return s;
    }
    function brownNoise() {
      const len = ctx.sampleRate * 6;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 900;
      loop(buf).connect(f);
      f.connect(gain(0.6)).connect(master);
    }
    // The recordings come from the app folder: through the desktop app (a page
    // opened from a file can't fetch files), or straight from the folder in a browser.
    async function load(name) {
      if (buffers.has(name)) return buffers.get(name);
      let bytes;
      if (apiReady() && typeof window.pywebview.api.get_sound === 'function') {
        const b64 = await window.pywebview.api.get_sound(name);
        if (!b64) throw new Error(`sound ${name} is missing`);
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        bytes = bytes.buffer;
      } else {
        bytes = await (await fetch(`sounds/${name}.ogg`)).arrayBuffer();
      }
      const buf = await ctx.decodeAudioData(bytes);
      buffers.set(name, buf);
      return buf;
    }

    function play(name) {
      if (!NAMES[name]) return;
      if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
      stopNodes();
      if (master) master.disconnect();
      const out = master = gain(0);
      master.connect(ctx.destination);
      current = name;
      if (ctx.state === 'suspended') ctx.resume();
      const fadeIn = () => {
        out.gain.setValueAtTime(0, ctx.currentTime);
        out.gain.linearRampToValueAtTime(volume * volume, ctx.currentTime + 1.5);
      };
      if (!RECORDED.has(name)) { brownNoise(); fadeIn(); return; }
      load(name).then((buf) => {
        if (master !== out) return; // switched to another sound while loading
        loop(buf, Math.random() * buf.duration).connect(out); // start somewhere different each time
        fadeIn();
      }).catch((err) => { report(err); if (master === out) { stop(); renderPlayer(); } });
    }

    function stopNodes() {
      stopFns.forEach((fn) => { try { fn(); } catch (err) { /* already stopped */ } });
      stopFns = [];
    }
    function stop() {
      if (!ctx || !master) { current = ''; return; }
      const old = master, fns = stopFns;
      old.gain.cancelScheduledValues(ctx.currentTime);
      old.gain.setValueAtTime(old.gain.value, ctx.currentTime);
      old.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.4); // fade out
      setTimeout(() => { fns.forEach((fn) => { try { fn(); } catch (err) { /* stopped */ } }); old.disconnect(); }, 500);
      stopFns = [];
      master = null;
      current = '';
    }
    function setVolume(v) {
      volume = Math.max(0, Math.min(1, Number(v) || 0));
      try { localStorage.setItem('student-dashboard-ambient-volume', String(volume)); } catch (err) { /* private mode */ }
      if (ctx && master) master.gain.setTargetAtTime(volume * volume, ctx.currentTime, 0.1);
    }
    return { NAMES, play, stop, setVolume, get current() { return current; }, get volume() { return volume; } };
  })();

  function ambientRow() {
    const chips = Object.entries(Ambient.NAMES).map(([key, label]) =>
      `<button type="button" class="amb-chip${Ambient.current === key ? ' on' : ''}" data-ambient="${key}" title="${Ambient.current === key ? 'Stop' : `Play ${label.toLowerCase()}`}">${esc(label)}</button>`).join('');
    const vol = Ambient.current
      ? `<input class="amb-vol" type="range" min="0" max="1" step="0.05" value="${Ambient.volume}" data-ambient-volume aria-label="Sound volume">` : '';
    return `<div class="amb"><span class="amb-label">Sounds</span>${chips}${vol}</div>`;
  }

  // ---------- quick add (Ctrl+Alt+A) ----------
  // One line, e.g. "CS essay fri 12:00": a module code makes it coursework,
  // "interview" an interview, anything else a plan in the Life view.
  const QA_TYPES = { coursework: 'Coursework', plan: 'Plan', deadline: 'Deadline', interview: 'Interview' };
  function parseQuick(text, today) {
    let rest = ` ${text} `;
    const blank = (start, end) => { rest = rest.slice(0, start) + ' '.repeat(end - start) + rest.slice(end); };
    const take = (re) => { const m = re.exec(rest); if (m) blank(m.index, m.index + m[0].length); return m; };
    let module = '';
    for (const m of list('modules')) {
      const code = String(m.code ?? '').trim();
      if (code && take(new RegExp(`(?<=\\s)#?${escapeRe(code)}(?=[\\s,.:;])`, 'i'))) { module = code; break; }
    }
    let date = null;
    const SI = window.ScheduleImport;
    const found = SI ? SI.findDates(rest, { today }).filter((f) => f.date) : [];
    let m;
    if (found.length) { date = startOfDay(found[0].date); blank(found[0].start, found[0].end); }
    else if ((m = take(/\b(today|tonight)\b/i))) date = today;
    else if ((m = take(/\b(tomorrow|tmrw|tmr)\b/i))) date = addDays(today, 1);
    else if ((m = take(/\bin\s+(\d{1,2})\s+days?\b/i))) date = addDays(today, +m[1]);
    else if ((m = take(/\b(next\s+)?(mon|tue|wed|thu|fri|sat|sun)(?:day|s|sday|nesday|rsday|urday|r|rs|es)?\b/i))) {
      const target = DAY_KEYS.findIndex((k) => k.toLowerCase() === m[2].toLowerCase());
      date = addDays(today, (target - today.getDay() + 7) % 7 + (m[1] ? 7 : 0));
    }
    const times = SI ? SI.findTimes(rest, []) : [];
    let time = '';
    if (times.length) { time = times[0].value; blank(times[0].start, times[0].end); }
    let type = module ? 'coursework' : /\binterview\b/i.test(text) ? 'interview'
      : /\b(due|deadline|submit|submission|hand in)\b/i.test(text) ? 'deadline' : 'plan';
    const FILLER = '(?:at|by|on|due|for|from|-|,|:)';
    let title = rest.replace(/\s+/g, ' ').trim();
    for (let i = 0; i < 3; i++) title = title.replace(new RegExp(`^${FILLER}\\s+|\\s+${FILLER}$|^${FILLER}$`, 'i'), '').trim();
    return { title, module, date, time, type };
  }

  function openQuickAdd() {
    if (SUMMARY || !data) return;
    closeEditor();
    const el = document.createElement('div');
    el.className = 'editor quick';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Quick add');
    panel.appendChild(el);
    editor = { id: null, source: 'quick', el, type: null };
    holdPanel(true);
    el.innerHTML = `<div class="ed-head"><b class="qa-head">Quick add</b>
        <span class="ed-msg">Try "CS essay fri 12:00", "Read chapter 4 tomorrow" or "Interview Google 3 Nov 14:00"</span>
        <button type="button" class="ed-x" data-qa="close" title="Close (Esc)">✕</button></div>
      <input class="qa-input" type="text" placeholder="What, which course, when…" autocomplete="off" spellcheck="false" aria-label="What to add">
      <div class="qa-preview" aria-live="polite"></div>`;
    const input = el.querySelector('.qa-input');
    const preview = () => {
      const today = startOfDay(now());
      const p = parseQuick(input.value, today);
      const type = editor.type || p.type;
      const box = el.querySelector('.qa-preview');
      if (!input.value.trim()) { box.innerHTML = '<span class="qa-hint">A course code makes it coursework; "interview" makes it an interview; anything else goes to your plans. Enter to add, Esc to close.</span>'; return; }
      const when = p.date ? `${shortDate(p.date)}${p.time ? ` ${p.time}` : ''}` : type === 'coursework' ? 'needs a date' : 'today';
      const types = Object.entries(QA_TYPES).map(([k, label]) => `<button type="button" class="qa-type${k === type ? ' on' : ''}" data-qa-type="${k}">${label}</button>`).join('');
      box.innerHTML = `<span class="qa-types">${types}</span>
        <span class="qa-what" style="--c:${moduleColor(p.module)}"><span class="dot"></span><b>${esc(p.title || '…')}</b>
        ${p.module ? ` · ${esc(moduleName(p.module))}` : ''} · <span class="${!p.date && type === 'coursework' ? 'qa-bad' : ''}">${esc(when)}</span></span>`;
    };
    const save = () => {
      const today = startOfDay(now());
      const p = parseQuick(input.value, today);
      const type = editor.type || p.type;
      const msg = el.querySelector('.ed-msg');
      if (!p.title) { msg.textContent = 'Type what it is first.'; msg.classList.add('err'); return; }
      if (type === 'coursework' && !p.date) { msg.textContent = 'Coursework needs a date, e.g. "fri" or "23 Oct".'; msg.classList.add('err'); return; }
      const date = iso(p.date || today);
      if (type === 'coursework') saved.coursework.push({ id: newId(), title: p.title, module: p.module, due: date, time: p.time, progress: 0 });
      else saved.plans.push({ id: `plan:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, type, title: p.title, date, start: p.time, end: '', where: '', notes: '' });
      persist();
      render(false);
      msg.classList.remove('err');
      msg.textContent = `Added to ${type === 'coursework' ? 'Coursework' : 'your plans'} ✓`;
      input.value = '';
      editor.type = null;
      preview();
      setTimeout(() => { if (editor && editor.source === 'quick') { closeEditor(); hideIfQuick(); } }, 700);
    };
    input.addEventListener('input', preview);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-qa-type]');
      if (t) { editor.type = t.dataset.qaType; preview(); input.focus(); return; }
      if (e.target.closest('[data-qa="close"]')) { closeEditor(); hideIfQuick(); }
    });
    preview();
    [0, 80, 250].forEach((ms) => setTimeout(() => input.focus(), ms));
  }
  // Quick add came from the hotkey: once it's done, get out of the way.
  function hideIfQuick() { if (apiReady()) Promise.resolve(window.pywebview.api.hide()).catch(() => {}); }
  window.openQuickAdd = openQuickAdd;
  // Switch view from outside the page (the focus timer, a notification).
  window.showView = (view) => {
    if (!['uni', 'life', 'study'].includes(view) || saved.view === view || !data) return;
    saved.view = view;
    persist();
    render(true);
  };
  window.showStudy = () => window.showView('study');

  // ---------- weekly review (summary.html?review) ----------
  function renderReview() {
    const root = document.getElementById('summary');
    document.title = 'Your week';
    const n = now();
    const today = startOfDay(n);
    moduleMap = new Map(list('modules').map((m) => [String(m.code ?? '').toLowerCase(), m]));
    const tasks = allTasks();
    const cws = allCoursework();
    const monday = addDays(today, -((today.getDay() + 6) % 7));
    const sunday = addDays(monday, 6);
    const nextMon = addDays(monday, 7);
    const hist = focusHistory();
    const goal = goalMinutes();
    const week = Array.from({ length: 7 }, (_, i) => addDays(monday, i)).map((d) => ({ d, m: Number(hist[iso(d)]) || 0 }));
    const total = week.reduce((s, x) => s + x.m, 0);
    const best = week.reduce((a, b) => (b.m > a.m ? b : a), week[0]);
    const goalDays = goal ? week.filter((x) => x.m >= goal).length : 0;
    const streak = focusStreak();

    const inWeek = (c) => c.dueD && c.dueD >= monday && c.dueD <= sunday;
    const due = cws.filter(inWeek).sort(byDue);
    const done = due.filter((c) => c.submitted);
    const open = cws.filter((c) => !c.submitted && c.dueD && c.dueD <= sunday && !(c.source === 'learn' && c.dueD < monday)).sort(byDue);

    // Next week, day by day (the important things, plus how much class time).
    let classMin = 0, classCount = 0;
    const kinds = { due: 0, interview: 0, plan: 0, exam: 0 };
    const groups = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(nextMon, i);
      const items = dayItems(day, today, tasks, cws);
      const classes = items.filter((it) => it.kind === 'class' && it.t >= 0);
      classCount += classes.length;
      classMin += classes.reduce((s, it) => s + (it.end - it.t), 0);
      const key = items.filter((it) => it.kind !== 'class');
      key.forEach((it) => { kinds[it.kind] = (kinds[it.kind] || 0) + 1; });
      if (key.length) groups.push({ day, key });
    }
    const nextParts = [];
    if (classCount) nextParts.push(count(classCount, 'class', 'classes'));
    if (kinds.due) nextParts.push(count(kinds.due, 'deadline', 'deadlines'));
    if (kinds.exam) nextParts.push(count(kinds.exam, 'exam', 'exams'));
    if (kinds.interview) nextParts.push(count(kinds.interview, 'interview', 'interviews'));
    if (kinds.plan) nextParts.push(count(kinds.plan, 'plan', 'plans'));

    const sentence = [
      total ? `<b>You focused ${esc(fmtDur(total))}</b> this week${best.m ? ` (best: ${DAY_LONG[best.d.getDay()]}, ${esc(fmtDur(best.m))})` : ''}.` : '<b>No focus sessions</b> this week yet.',
      due.length ? `You submitted ${done.length} of ${count(due.length, 'deadline', 'deadlines')} due this week.` : 'Nothing was due this week.',
      `<b>Next week:</b> ${esc(nextParts.length ? listText(nextParts) : 'nothing scheduled yet')}.`,
    ].join(' ');

    const top = Math.max(60, goal * 1.15, ...week.map((x) => x.m));
    const bars = week.map(({ d, m }) => `<div class="fw-day${daysBetween(today, d) === 0 ? ' today' : ''}${d > today ? ' future' : ''}${goal && m >= goal ? ' met' : ''}" title="${esc(`${DAY_LONG[d.getDay()]}: ${m ? fmtDur(m) : 'no focus time'}`)}">
        <span class="fw-val">${m ? esc(shortDur(m)) : ''}</span>
        <div class="fw-track" style="--goal:${goal ? ((goal / top) * 100).toFixed(1) : -10}%"><i style="height:${((m / top) * 100).toFixed(1)}%"></i></div>
        <span class="fw-key">${DAY_KEYS[d.getDay()]}</span></div>`).join('');
    const items = Object.values((mediaState && mediaState.focus && mediaState.focus.byItem) || {})
      .filter((x) => x.minutes).sort((a, b) => b.minutes - a.minutes).slice(0, 4);
    const cwItem = (c, kind) => summaryItem({
      title: c.title, color: moduleColor(c.module), kind,
      detail: [moduleName(c.module) || cleanCourse(c.course), focusSpent(c.id)].filter(Boolean).join(' · '),
    }, c.dueD ? `${DAY_KEYS[c.dueD.getDay()]} ${c.dueD.getDate()}` : '', false);

    root.innerHTML = `
      <header class="sum-head">
        <div>
          <h1>Your week</h1>
          <p class="sum-date">${shortDate(monday)} – ${shortDate(sunday)}</p>
        </div>
        <div class="sum-actions">
          <button type="button" class="btn" data-sum="dashboard">Open dashboard</button>
          <button type="button" class="btn primary" data-sum="close">Close</button>
        </div>
      </header>
      <p class="sum-line">${sentence}${open.some((c) => c.dueD < today) ? ` <span class="sum-alert">${count(open.filter((c) => c.dueD < today).length, 'item is', 'items are')} overdue</span>` : ''}</p>
      <section class="sum-cols">
        <div class="sum-col"><h2>Focus <span>${total ? esc(fmtDur(total)) : 'none yet'}</span></h2>
          <div class="card-body fw rv-fw">${bars}</div>
          <p class="sum-foot">${goal ? `Goal of ${esc(fmtDur(goal))} met on ${count(goalDays, 'day', 'days')}${streak ? ` · ${streak}-day streak` : ''}` : 'Set dailyGoalMinutes under study in my-data.js for a daily goal.'}</p>
          ${items.length ? `<ul class="si-list rv-items">${items.map((x) => summaryItem({ title: x.title, detail: '', kind: 'focus', color: 'var(--accent)' }, fmtDur(x.minutes), false)).join('')}</ul>` : ''}
        </div>
        <div class="sum-col"><h2>Coursework <span>this week</span></h2>
          ${done.length ? `<h3 class="rv-sub">Submitted ✓</h3><ul class="si-list">${done.map((c) => cwItem(c, 'done')).join('')}</ul>` : ''}
          ${open.length ? `<h3 class="rv-sub">Still to do</h3><ul class="si-list">${open.map((c) => cwItem(c, c.dueD < today ? 'late' : 'due')).join('')}</ul>` : '<p class="si-empty">Nothing left to do this week.</p>'}
        </div>
        <div class="sum-col"><h2>Next week <span>${shortDate(nextMon)} – ${shortDate(addDays(nextMon, 6))}</span></h2>
          ${groups.length ? `<ul class="si-list">${groups.map((g) => g.key.map((it) => summaryItem(
            { ...it, detail: [it.when, it.detail].filter(Boolean).join(' · ') }, `${DAY_KEYS[g.day.getDay()]} ${g.day.getDate()}`, false,
          )).join('')).join('')}</ul>` : '<p class="si-empty">No deadlines, interviews or plans yet.</p>'}
          <p class="sum-foot">${classCount ? `${count(classCount, 'class', 'classes')}, ${fmtHours(classMin)} in total` : 'No classes next week'}</p>
        </div>
      </section>`;
  }

  // ---------- showing / hiding ----------
  function onShown() {
    recentlyTicked.clear();
    pickingFor = null;
    if (editor) holdPanel(true); // a half-filled form survives the panel closing
    loadSystemTheme(); // picks up Windows light/dark or accent changes
    render(true);
  }
  // While the desktop panel is parked off-screen there's nothing to see, so the
  // clock only redraws it when the date changes (reminders need the new day).
  let parked = false;
  window.onDashShown = () => { parked = false; body.classList.remove('parked'); onShown(); };
  window.onDashHidden = () => { parked = true; body.classList.add('parked'); };

  // Called by the desktop app (and on pywebviewready) to switch to full-window mode.
  function enterAppMode() {
    if (appMode) return;
    appMode = true;
    if (SUMMARY) return;
    parked = true; // the desktop window starts off-screen
    body.classList.add('parked');
    body.classList.add('app', 'open');
    render(true);
  }
  // In the desktop app, page errors are written to dashboard.log.
  function report(err) {
    console.error(err);
    if (apiReady() && typeof window.pywebview.api.log_error === 'function') {
      const text = err && err.stack ? err.stack : String(err && err.message ? err.message : err);
      Promise.resolve(window.pywebview.api.log_error(text)).catch(() => {});
    }
  }
  window.addEventListener('error', (e) => report(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => report(e.reason));

  async function loadFeeds() {
    if (!(apiReady() && typeof window.pywebview.api.get_feeds === 'function')) return;
    try { feeds = await window.pywebview.api.get_feeds(); } catch (err) { report(err); }
  }
  // The desktop app calls this whenever a calendar has been refreshed.
  window.onFeedsUpdated = async (snapshot) => {
    if (snapshot && typeof snapshot === 'object') feeds = snapshot;
    else await loadFeeds();
    render(false);
  };

  async function onApiReady() {
    enterAppMode();
    await loadSystemTheme();
    await loadSaved();
    await loadFeeds();
    await loadMedia();
    savedLoaded = true;
    render(true);
  }
  window.enterAppMode = enterAppMode;
  window.addEventListener('pywebviewready', onApiReady);
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !apiReady()) return;
    if (SUMMARY) window.pywebview.api.close_summary();
    else if (appMode) window.pywebview.api.hide();
  });

  function setupBrowserPreview() {
    if (params.has('pin')) { body.classList.add('open'); return; }
    const zone = document.getElementById('hoverZone');
    let openTimer = 0, closeTimer = 0;
    const open = () => { if (appMode || body.classList.contains('open')) return; body.classList.add('open'); onShown(); };
    const close = () => { if (!appMode && !editor) body.classList.remove('open'); };
    zone.addEventListener('mouseenter', () => { clearTimeout(closeTimer); openTimer = setTimeout(open, 250); });
    zone.addEventListener('mouseleave', () => clearTimeout(openTimer));
    panel.addEventListener('mouseenter', () => clearTimeout(closeTimer));
    panel.addEventListener('mouseleave', () => { closeTimer = setTimeout(close, 350); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }

  // ---------- start ----------
  if (window.DASHBOARD_DATA && typeof window.DASHBOARD_DATA === 'object') {
    baseData = window.DASHBOARD_DATA;
    rebuildData();
  } else {
    dataError = window.__dataError || '';
  }
  applyTheme();
  // The settings window saved something: pick it up straight away.
  window.onSettingsChanged = async () => { await loadSaved(); render(false); };

  (async () => {
    if (apiReady()) await onApiReady();
    else { await loadSaved(); render(true); }
    if (!SUMMARY) setupBrowserPreview();
  })();

  // Keep times fresh: re-render whenever the minute changes (only the day, while parked).
  setInterval(() => {
    const n = now();
    const key = `${iso(n)} ${n.getHours()}:${n.getMinutes()}`;
    if (key === lastMinute) return;
    if (parked && !SUMMARY && lastMinute.startsWith(`${iso(n)} `)) return;
    render(false);
  }, 5000);
})();
