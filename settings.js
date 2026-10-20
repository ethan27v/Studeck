// =====================================================================
//  The setup / settings window (settings.html).
//
//  First run (settings.html?welcome) it's a step-by-step setup; later it's
//  the settings, with the same pages. Everything is saved as you go:
//  settings to state.json ("settings"), calendar links to the private
//  calendar-links.txt, and switches like "start at login" straight away.
// =====================================================================
(() => {
  'use strict';

  // First time: step-by-step setup (the app says so; settings.html?welcome in a browser).
  let WELCOME = new URLSearchParams(location.search).has('welcome');
  const PALETTE = ['coral', 'amber', 'mint', 'sky', 'violet', 'rose', 'lime', 'slate'];
  const THEMES = [['auto', 'Match my computer'], ['windows-dark', 'Dark'], ['windows-light', 'Light'],
    ['sage', 'Sage (dark green-grey)'], ['sand', 'Sand (warm light)'], ['midnight', 'Midnight (navy)']];
  const DAY_KEYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WEEK_DAYS = [['mon', 'Mon'], ['tue', 'Tue'], ['wed', 'Wed'], ['thu', 'Thu'], ['fri', 'Fri'], ['sat', 'Sat'], ['sun', 'Sun']];
  const CLASS_TYPES = ['Lecture', 'Tutorial', 'Lab', 'Seminar', 'Workshop', 'Practical', 'Studio'];
  // What unis call their teaching blocks.
  const TERM_WORDS = ['Semester', 'Term', 'Trimester', 'Quarter'];
  const word = () => (TERM_WORDS.includes(st.termWord) ? st.termWord : 'Semester');
  const lword = () => word().toLowerCase();
  // A term found in the timetable, named with your uni's word ("Term 2").
  const termName = (t) => (t.number ? `${word()} ${t.number}` : t.name);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let STEPS = [];
  const makeSteps = () => [
    { id: 'you', title: WELCOME ? 'Welcome' : 'You' },
    { id: 'calendars', title: 'Calendars' },
    { id: 'semesters', title: 'Teaching weeks' },
    { id: 'modules', title: 'Modules' },
    { id: 'classes', title: 'Classes' },
    { id: 'study', title: 'Study & look' },
    ...(WELCOME ? [{ id: 'done', title: 'All set' }] : []),
  ];

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const parseDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; };
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const shortDate = (d) => `${DAY_KEYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const api = () => (window.pywebview && window.pywebview.api) || null;

  const file = (window.DASHBOARD_DATA && typeof window.DASHBOARD_DATA === 'object') ? window.DASHBOARD_DATA : {};
  let st = {};             // the settings being edited
  let platform = { name: 'windows', keys: { toggle: 'Ctrl+Alt+D', quickadd: 'Ctrl+Alt+A' }, autostartLabel: 'Start with Windows', edgeTrigger: true };
  let prefs = {};          // app switches (start at login, pop-ups, reminders)
  let links = {};          // which calendar links are set
  let feeds = {};          // calendar sync status, and the semesters found in the timetable
  let step = 0;
  let checking = { learn: 0, timetable: 0 }; // when we asked for a calendar check

  // ---------- starting values ----------
  function defaults(saved) {
    const s = saved && typeof saved === 'object' ? JSON.parse(JSON.stringify(saved)) : {};
    const fileStudy = file.study || file.music || {};
    if (s.name == null) s.name = file.sample ? '' : String(file.name || '');
    if (!s.theme) s.theme = file.theme || 'auto';
    if (s.deadlinesName == null) s.deadlinesName = file.sample ? '' : String(file.deadlinesName || '');
    if (!TERM_WORDS.includes(s.termWord)) s.termWord = 'Semester';
    if (!s.semesters) {
      const sem = file.semester || {};
      s.semesters = { mode: 'auto', terms: !file.sample && sem.start ? [{ name: sem.name || 'Semester 1', start: sem.start, weeks: sem.teachingWeeks || 11, breakWeeks: sem.breakWeeks || [] }] : [] };
    }
    if (!Array.isArray(s.modules)) s.modules = [];
    if (!Array.isArray(s.classes)) s.classes = [];
    s.study = {
      focusMinutes: 25, breakMinutes: 5, dailyGoalMinutes: 120, miniTimer: true,
      ...Object.fromEntries(Object.entries(fileStudy).filter(([k]) => ['focusMinutes', 'breakMinutes', 'dailyGoalMinutes', 'miniTimer'].includes(k))),
      ...(s.study || {}),
    };
    return s;
  }

  let saveTimer = 0;
  function save(now) {
    clearTimeout(saveTimer);
    const run = () => {
      const out = { ...st, setupDone: !!st.setupDone || !WELCOME };
      if (api()) Promise.resolve(api().save_settings(out)).catch(console.error);
    };
    if (now) run(); else saveTimer = setTimeout(run, 350);
  }

  // ---------- modules (the same rules as the dashboard: see buildModules in app.js) ----------
  const cleanCourseName = (c) => String(c ?? '').replace(/\s*[([].*$/, '').trim();
  const STOP_WORDS = new Set(['and', 'of', 'to', 'the', 'in', 'for', 'a', 'an', 'with', 'on', '&']);
  function abbrev(name) {
    const words = String(name).split(/[\s-]+/).filter((w) => w && !STOP_WORDS.has(w.toLowerCase()));
    if (words.length === 1) return words[0].replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'MOD';
    return words.map((w) => (/^\d/.test(w) ? w : w[0])).join('').replace(/[^A-Za-z0-9]/g, '').slice(0, 5).toUpperCase() || 'MOD';
  }
  function colourFor(name, taken) {
    let h = 0;
    for (const ch of String(name).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    for (let i = 0; i < PALETTE.length; i++) {
      const c = PALETTE[(h + i) % PALETTE.length];
      if (!taken.has(c)) return c;
    }
    return PALETTE[h % PALETTE.length];
  }
  const timetableTerms = () => (feeds.timetable && Array.isArray(feeds.timetable.terms) ? feeds.timetable.terms : []);

  // Every course worth listing, grouped: this semester, next, your own, other.
  function courseRows() {
    const today = new Date();
    const terms = timetableTerms().map((t) => ({ ...t, startD: parseDate(t.start), endD: addDays(parseDate(t.start), t.weeks * 7) }));
    const current = terms.find((t) => t.startD <= today && today < t.endD);
    const next = terms.filter((t) => t.startD > today).sort((a, b) => a.startD - b.startD)[0];
    const recentPast = terms.filter((t) => t.endD <= today && addDays(t.endD, 120) >= today && t !== current);
    const rows = [];
    const seen = new Set();
    // Modules you set up in your data file keep their code and colour.
    const fileMods = Array.isArray(file.modules) && !file.sample ? file.modules : [];
    const fromFile = (key) => fileMods.find((m) => cleanCourseName(m.name || m.code).toLowerCase() === key
      || (Array.isArray(m.match) && m.match.some((w) => cleanCourseName(w).toLowerCase() === key)));
    const add = (name, group, extra = {}) => {
      const key = cleanCourseName(name).toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      const f = fromFile(key);
      rows.push({ name: cleanCourseName(name), group, ...(f ? { fileCode: f.code, fileColor: f.color } : {}), ...extra });
    };
    if (current) current.courses.forEach((c) => add(c, `Now · ${termName(current)}`));
    if (next) next.courses.forEach((c) => add(c, `Next · ${termName(next)} (from ${shortDate(next.startD)})`));
    recentPast.forEach((t) => t.courses.forEach((c) => add(c, `Finished · ${termName(t)}`)));
    fileMods.forEach((m) => add(m.name || m.code, 'In your data file'));
    st.modules.filter((m) => m.manual).forEach((m) => add(m.name, 'Added by you', { manual: true }));
    // Defaults, then what you've set.
    const taken = new Set();
    const codes = new Set();
    for (const r of rows) {
      const o = st.modules.find((m) => m.name.toLowerCase() === r.name.toLowerCase()) || {};
      r.code = o.code || r.fileCode || abbrev(r.name);
      let base = r.code, i = 2;
      while (codes.has(r.code.toLowerCase()) && !o.code) r.code = `${base}${i++}`;
      codes.add(r.code.toLowerCase());
      r.color = o.color || r.fileColor || '';
      r.hidden = !!o.hidden;
    }
    for (const r of rows) {
      if (!r.color) r.color = colourFor(r.name, taken);
      taken.add(r.color);
    }
    return rows;
  }
  function setModule(name, change) {
    let m = st.modules.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!m) { m = { name }; st.modules.push(m); }
    Object.assign(m, change);
    save();
  }

  // ---------- pages ----------
  const howToOpen = () => (platform.edgeTrigger
    ? `Rest your mouse on the very top edge of the screen for a moment, or press <kbd>${esc(platform.keys.toggle)}</kbd>.`
    : `Press <kbd>${esc(platform.keys.toggle)}</kbd>, or click the dashboard icon in the menu bar.`);

  const PAGES = {
    you() {
      return `
        <h1>${WELCOME ? 'Welcome to Studeck' : 'You'}</h1>
        ${WELCOME ? `<p class="st-lead">A panel at the top of your screen with your timetable, deadlines, coursework, plans, music and a focus timer. This takes about two minutes, and you can change anything later from the <b>⚙</b> on the dashboard or the ${platform.name === 'mac' ? 'menu bar' : 'tray'} icon.</p>` : ''}
        <label class="st-field"><span>What should the dashboard call you?</span>
          <input type="text" data-set="name" value="${esc(st.name)}" placeholder="Your first name (optional)" maxlength="60" autocomplete="given-name"></label>
        <div class="st-card">
          <h2>Opening the dashboard</h2>
          <p>${howToOpen()}</p>
          <p>Press <kbd>${esc(platform.keys.quickadd)}</kbd> anywhere to quickly add a deadline or plan, e.g. <i>"CS essay fri 12:00"</i>.</p>
          ${platform.name === 'mac' ? '<p class="st-note">Mac support is new (beta). If something doesn\'t work, the log is in the <code>.studeck</code> folder in your home folder.</p>' : ''}
        </div>
        ${!WELCOME ? `<div class="st-card"><h2>Advanced</h2><p>Your own weekly classes, to-dos and extra coursework can also go in a data file.</p>
          <button type="button" class="btn" data-act="data-file">Open my data file</button></div>` : ''}`;
    },

    calendars() {
      const status = (kind) => {
        const f = feeds[kind] || {};
        const l = links[kind] || {};
        if (checking[kind] && Date.now() - checking[kind] < 30000 && !(f.updated && f.ok)) {
          if (f.error) return `<p class="st-status bad">${esc(f.error)}</p>`;
          return '<p class="st-status wait">Checking the link…</p>';
        }
        if (!l.set) return '<p class="st-status">Not connected yet.</p>';
        if (f.error && !f.ok) return `<p class="st-status bad">${esc(f.error)}</p>`;
        if (kind === 'learn') {
          const n = (f.deadlines || []).length;
          return `<p class="st-status ok">Connected (${esc(l.host)}) · ${n} upcoming deadline${n === 1 ? '' : 's'} found.</p>`;
        }
        const n = (f.events || []).length;
        const terms = (f.terms || []).length;
        return `<p class="st-status ok">Connected (${esc(l.host)}) · ${n} classes in the next few weeks${terms ? ` · ${terms} ${lword()}${terms === 1 ? '' : 's'} found` : ''}.</p>`;
      };
      const linkField = (kind, label, placeholder) => `
        <label class="st-field"><span>${label}</span>
          <span class="st-row"><input type="url" data-link="${kind}" placeholder="${links[kind] && links[kind].set ? 'Paste a new link to replace it' : placeholder}" spellcheck="false" autocomplete="off">
          <button type="button" class="btn primary" data-act="link" data-kind="${kind}">${links[kind] && links[kind].set ? 'Replace' : 'Connect'}</button>
          ${links[kind] && links[kind].set ? `<button type="button" class="btn" data-act="unlink" data-kind="${kind}">Remove</button>` : ''}</span></label>
        <p class="st-note">No link? <button type="button" class="st-linkbtn" data-act="ics-file" data-kind="${kind}">Use a downloaded .ics file</button> instead (it won't update by itself: download and pick it again when things change).</p>
        ${status(kind)}`;
      return `
        <h1>Calendars</h1>
        <p class="st-lead">The dashboard fills itself in from two private calendar links (or downloaded calendar files). Both are optional: without them you can type in your classes on the <b>Classes</b> page and add coursework and plans on the dashboard.</p>
        <div class="st-card">
          <h2>1. Deadlines</h2>
          <label class="st-field st-narrow"><span>What's your university's learning site called?</span>
            <input type="text" data-set="deadlinesName" value="${esc(st.deadlinesName)}" placeholder="Moodle, Canvas, Blackboard…" maxlength="30"></label>
          ${linkField('learn', 'Its calendar link', 'https://… or webcal://…')}
          <details><summary>Where do I find this link?</summary>
            <ul>
              <li><b>Moodle</b>: Calendar → <i>Export calendar</i> (or <i>Import or export calendars</i>) → pick all courses and a time range → <i>Get calendar URL</i>.</li>
              <li><b>Canvas</b>: Calendar → <i>Calendar Feed</i> (bottom right) → copy the link.</li>
              <li><b>Blackboard</b> (Learn, Ultra): Calendar → cog icon (Calendar Settings) → <i>Share Calendar</i> → copy the link.</li>
              <li><b>Brightspace (D2L)</b>: Calendar → <i>Subscribe</i> → copy the link.</li>
              <li><b>Sakai</b>: Calendar → <i>Subscribe</i> (or <i>Generate private URL</i>).</li>
              <li>Anything else: look for <i>Subscribe</i>, <i>Export</i>, <i>iCal</i> or <i>.ics</i> in its calendar.</li>
            </ul></details>
        </div>
        <div class="st-card">
          <h2>2. Timetable (your classes)</h2>
          ${linkField('timetable', 'Timetable calendar link', 'https://… or webcal://…')}
          <details><summary>Where do I find this link?</summary>
            <ul>
              <li><b>Your uni's timetable website</b> (MyTimetable, Scientia, CELCAT, Syllabus Plus, your student portal…): look for <i>Subscribe</i>, <i>Sync</i>, <i>Export</i>, <i>iCal</i> or <i>Add to calendar</i> and copy the link. If it only offers a download, use the .ics file option above.</li>
              <li><b>Timetable in your uni Outlook / Microsoft 365 calendar</b>: Outlook on the web → Settings → Calendar → Shared calendars → <i>Publish a calendar</i> → pick <i>Calendar</i> and <i>Can view all details</i> → Publish → copy the <b>ICS</b> link.</li>
              <li><b>Google Calendar</b>: Settings → your calendar → <i>Secret address in iCal format</i>.</li>
              <li><b>Apple Calendar (iCloud)</b>: share the calendar as a <i>Public Calendar</i> and copy the link.</li>
              <li><b>No calendar at all?</b> Type your weekly classes in on the <b>Classes</b> page.</li>
            </ul></details>
        </div>
        <p class="st-note">Treat these links like passwords: anyone who has one can read that calendar. They're stored only on this computer, outside the app folder.</p>`;
    },

    semesters() {
      // This year's semesters (not ones that finished long ago), in order.
      const terms = timetableTerms()
        .filter((t) => addDays(parseDate(t.end) || parseDate(t.start), 120) >= new Date())
        .sort((a, b) => String(a.start).localeCompare(String(b.start)));
      const sem = st.semesters;
      const manual = sem.mode === 'manual' || !terms.length;
      const termLine = (t) => {
        const start = parseDate(t.start);
        const end = parseDate(t.end) || addDays(start, t.weeks * 7 - 3);
        const breaks = t.breakWeeks && t.breakWeeks.length ? ` · break in week ${t.breakWeeks.join(', ')}` : '';
        return `<li><b>${esc(termName(t))}</b> ${shortDate(start)} – ${shortDate(end)} · ${t.weeks} teaching weeks${breaks}${t.courses && t.courses.length ? ` · ${t.courses.length} courses` : ''}</li>`;
      };
      const rows = (sem.terms.length ? sem.terms : [{ name: `${word()} 1`, start: '', weeks: 11, breakWeeks: [] }]).map((t, i) => `
        <div class="st-term" data-term="${i}">
          <input type="text" data-term-field="name" value="${esc(t.name)}" placeholder="${word()} ${i + 1}" maxlength="40" aria-label="Name">
          <label><span>Week 1 starts</span><input type="date" data-term-field="start" value="${esc(t.start)}"></label>
          <label><span>Teaching weeks</span><input type="number" min="1" max="30" data-term-field="weeks" value="${esc(t.weeks)}"></label>
          <label><span>Break weeks</span><input type="text" data-term-field="breakWeeks" value="${esc((t.breakWeeks || []).join(', '))}" placeholder="e.g. 6"></label>
          <button type="button" class="btn" data-act="term-remove" data-i="${i}" title="Remove">✕</button>
        </div>`).join('');
      return `
        <h1>Teaching weeks</h1>
        <p class="st-lead">The dashboard shows which teaching week you're in ("Week 5 of 11"), how far through the ${lword()} you are, break weeks, and when the next ${lword()} starts.</p>
        <label class="st-field st-narrow"><span>What does your uni call them?</span>
          <select data-set="termWord">${TERM_WORDS.map((w) => `<option value="${w}"${word() === w ? ' selected' : ''}>${w}s</option>`).join('')}</select></label>
        ${terms.length ? `
          <div class="st-card">
            <h2>Found in your timetable</h2>
            <ul class="st-terms">${terms.map(termLine).join('')}</ul>
            <label class="st-check"><input type="radio" name="semmode" value="auto" ${manual ? '' : 'checked'}> <span><b>Use my timetable</b> (recommended): updates by itself every ${lword()} and year.</span></label>
            <label class="st-check"><input type="radio" name="semmode" value="manual" ${manual ? 'checked' : ''}> <span>Enter the dates myself</span></label>
          </div>` : `
          <div class="st-card"><p>${(links.timetable || {}).set ? 'No teaching weeks found in your timetable yet (it may still be syncing).' : 'Connect your timetable (Calendars page) and this fills itself in.'} Or enter your ${lword()} dates here:</p></div>`}
        ${manual ? `<div class="st-card"><h2>Your ${lword()}s</h2>${rows}
          <button type="button" class="btn" data-act="term-add">+ Add a ${lword()}</button>
          <p class="st-note">Week 1 starts on the Monday of your first teaching week. Break weeks are teaching weeks with no classes (like a reading week); leave empty if there's none.</p></div>` : ''}`;
    },

    modules() {
      const rows = courseRows();
      let lastGroup = '';
      const body = rows.map((r) => {
        const header = r.group !== lastGroup ? `<h3 class="st-group">${esc(r.group)}</h3>` : '';
        lastGroup = r.group;
        const swatches = PALETTE.map((c) => `<button type="button" class="st-swatch${r.color === c ? ' on' : ''}" style="--c:var(--c-${c})" data-act="colour" data-name="${esc(r.name)}" data-colour="${c}" title="${c}" aria-label="${c}"></button>`).join('');
        return `${header}<div class="st-mod${r.hidden ? ' hidden' : ''}">
          <span class="st-dot" style="--c:var(--c-${PALETTE.includes(r.color) ? r.color : 'slate'})"></span>
          <input type="text" class="st-code" data-act="code" data-name="${esc(r.name)}" value="${esc(r.code)}" maxlength="8" aria-label="Short code for ${esc(r.name)}">
          <span class="st-name" title="${esc(r.name)}">${esc(r.name)}</span>
          <span class="st-swatches">${swatches}</span>
          <label class="st-hide"><input type="checkbox" data-act="hide" data-name="${esc(r.name)}" ${r.hidden ? 'checked' : ''}> Hide</label>
          ${r.manual ? `<button type="button" class="btn" data-act="mod-remove" data-name="${esc(r.name)}" title="Remove">✕</button>` : ''}
        </div>`;
      }).join('');
      return `
        <h1>Modules</h1>
        <p class="st-lead">Each course gets a colour and a short code, used across the dashboard. Courses from your timetable appear by themselves${timetableTerms().length ? '' : ' once it\'s connected'}, including next ${lword()}'s.</p>
        <div class="st-card st-mods">${body || '<p>No courses yet. Connect your timetable, or add them here.</p>'}</div>
        <div class="st-card">
          <h2>Add a course</h2>
          <p class="st-note">For a course that isn't in your timetable (e.g. an online one).</p>
          <span class="st-row"><input type="text" id="newModName" placeholder="Course name" maxlength="120">
          <input type="text" id="newModCode" placeholder="Code" maxlength="8" class="st-code">
          <button type="button" class="btn primary" data-act="mod-add">Add</button></span>
        </div>`;
    },

    classes() {
      const mods = courseRows().filter((r) => !r.hidden);
      const ttSet = links.timetable && links.timetable.set;
      const opt = (v, label, on) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label)}</option>`;
      const rows = st.classes.map((c, i) => {
        const known = mods.some((m) => m.name.toLowerCase() === String(c.module).toLowerCase());
        return `<div class="st-class" data-class="${i}">
          <select data-class-field="module" aria-label="Course">${opt('', 'Course…', !c.module)}${mods.map((m) => opt(m.name, `${m.code} · ${m.name}`, known && m.name.toLowerCase() === String(c.module).toLowerCase())).join('')}${c.module && !known ? opt(c.module, c.module, true) : ''}</select>
          <input type="text" list="classTypes" data-class-field="type" value="${esc(c.type)}" placeholder="Lecture" maxlength="40" aria-label="Type">
          <select data-class-field="day" aria-label="Day">${WEEK_DAYS.map(([v, l]) => opt(v, l, c.day === v)).join('')}</select>
          <input type="time" data-class-field="start" value="${esc(c.start)}" aria-label="Starts">
          <input type="time" data-class-field="end" value="${esc(c.end)}" aria-label="Ends">
          <input type="text" data-class-field="room" value="${esc(c.room)}" placeholder="Room" maxlength="120" aria-label="Room">
          <button type="button" class="btn" data-act="class-remove" data-i="${i}" title="Remove">✕</button>
        </div>`;
      }).join('');
      return `
        <h1>Classes</h1>
        <p class="st-lead">${ttSet
          ? 'Your timetable calendar is connected, so the dashboard takes your classes from it and you can skip this page. (Classes typed in here are used if you remove the timetable link.)'
          : 'No timetable calendar? Type in your weekly classes. They show on the dashboard every teaching week, and are left out of break weeks and the weeks between ' + lword() + 's.'}</p>
        ${mods.length ? '' : '<p class="st-note">Tip: add your courses on the <b>Modules</b> page first, so each class gets its course colour.</p>'}
        <div class="st-card">
          ${rows ? `<div class="st-class st-class-head"><span>Course</span><span>Type</span><span>Day</span><span>Starts</span><span>Ends</span><span>Room</span><span></span></div>
          <div class="st-classes">${rows}</div>` : '<p>No classes typed in.</p>'}
          <span class="st-row"><button type="button" class="btn" data-act="class-add">+ Add a class</button></span>
          <datalist id="classTypes">${CLASS_TYPES.map((t) => `<option value="${t}">`).join('')}</datalist>
          <p class="st-note">One-off events (a field trip, an exam) are easier to add as plans on the dashboard.</p>
        </div>`;
    },

    study() {
      const s = st.study;
      const toggle = (name, label, hint = '') => `<label class="st-check"><input type="checkbox" data-pref="${name}" ${prefs[name] ? 'checked' : ''}> <span>${label}${hint ? `<small>${hint}</small>` : ''}</span></label>`;
      const studyToggle = (key, label, hint = '') => `<label class="st-check"><input type="checkbox" data-study-flag="${key}" ${s[key] !== false ? 'checked' : ''}> <span>${label}${hint ? `<small>${hint}</small>` : ''}</span></label>`;
      const goals = [[0, 'No goal'], [60, '1 hour'], [90, '1½ hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours'], [300, '5 hours']];
      return `
        <h1>Study & look</h1>
        <div class="st-card">
          <h2>Look</h2>
          <label class="st-field st-narrow"><span>Colours</span><select data-set="theme">${THEMES.map(([v, l]) => `<option value="${v}"${st.theme === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
        </div>
        <div class="st-card">
          <h2>Focus timer</h2>
          <div class="st-grid">
            <label class="st-field"><span>Usual focus length (minutes)</span><input type="number" min="5" max="180" data-study="focusMinutes" value="${esc(s.focusMinutes)}"></label>
            <label class="st-field"><span>Break (minutes)</span><input type="number" min="1" max="60" data-study="breakMinutes" value="${esc(s.breakMinutes)}"></label>
            <label class="st-field"><span>Daily focus goal</span><select data-study="dailyGoalMinutes">${goals.map(([v, l]) => `<option value="${v}"${+s.dailyGoalMinutes === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
          </div>
          ${studyToggle('miniTimer', 'Show a small timer in the corner while it runs')}
        </div>
        <div class="st-card">
          <h2>${platform.name === 'mac' ? 'Mac' : 'Windows'}</h2>
          ${toggle('autostart', esc(platform.autostartLabel), 'so the dashboard is ready when you log in')}
          ${toggle('summary', '"Today at a glance" pop-up', 'the first time you use your computer each day')}
          ${toggle('review', 'Weekly review on Sunday evenings')}
          ${toggle('reminders', 'Deadline reminders', '3 days and 1 day before, and on the morning')}
          <span class="st-row"><button type="button" class="btn" data-act="test-note">Show a test notification</button></span>
        </div>`;
    },

    done() {
      const terms = timetableTerms();
      const connected = ['learn', 'timetable'].filter((k) => links[k] && links[k].set).length;
      return `
        <h1>You're all set${st.name ? `, ${esc(st.name)}` : ''}!</h1>
        <div class="st-card">
          <ul class="st-summary">
            <li>${connected ? `${connected} calendar${connected === 1 ? '' : 's'} connected` : 'No calendars connected (you can add them any time)'}</li>
            <li>${terms.length && st.semesters.mode !== 'manual' ? `${word()}s from your timetable` : st.semesters.terms.length ? `${st.semesters.terms.length} ${lword()}${st.semesters.terms.length === 1 ? '' : 's'} entered` : `No ${lword()} dates yet`}</li>
            <li>${courseRows().filter((r) => !r.hidden).length} modules</li>
            ${st.classes.length ? `<li>${st.classes.length} weekly class${st.classes.length === 1 ? '' : 'es'} typed in</li>` : ''}
          </ul>
          <p>${howToOpen()}</p>
        </div>
        <span class="st-row"><button type="button" class="btn primary" data-act="open">Open the dashboard</button>
        <button type="button" class="btn" data-act="close">Close</button></span>`;
    },
  };

  // ---------- drawing ----------
  function draw(focusTop) {
    const keep = document.activeElement && document.activeElement.matches('input[type=text], input[type=url], input[type=number], input[type=date]')
      ? { sel: activeSelector(document.activeElement), start: document.activeElement.selectionStart } : null;
    $('#nav').innerHTML = STEPS.map((s, i) => `<button type="button" class="st-step${i === step ? ' on' : ''}${WELCOME && i < step ? ' done' : ''}" data-step="${i}">${WELCOME ? `<span class="st-num">${i + 1}</span>` : ''}${esc(s.title)}</button>`).join('');
    $('#page').innerHTML = PAGES[STEPS[step].id]();
    $('#foot').innerHTML = WELCOME
      ? (STEPS[step].id === 'done' ? '' : `${step ? '<button type="button" class="btn" data-act="back">Back</button>' : ''}
         <span class="st-foot-note">${STEPS[step].id === 'calendars' ? 'You can skip this and connect them later.' : ''}</span>
         <button type="button" class="btn primary" data-act="next">${step === STEPS.length - 2 ? 'Finish' : 'Next'}</button>`)
      : `<span class="st-foot-note">Changes are saved as you go.</span><button type="button" class="btn primary" data-act="close">Done</button>`;
    if (focusTop) $('#page').scrollTop = 0;
    if (keep && keep.sel) {
      const el = $(keep.sel);
      if (el) { el.focus(); try { el.setSelectionRange(keep.start, keep.start); } catch (err) { /* not a text field */ } }
    }
  }
  function activeSelector(el) {
    for (const attr of ['data-set', 'data-link', 'data-study', 'data-term-field']) {
      if (el.hasAttribute(attr)) {
        const term = el.closest('[data-term]');
        return `${term ? `[data-term="${term.dataset.term}"] ` : ''}[${attr}="${el.getAttribute(attr)}"]`;
      }
    }
    if (el.dataset.act === 'code') return `[data-act="code"][data-name="${CSS.escape(el.dataset.name)}"]`;
    return el.id ? `#${el.id}` : '';
  }
  function go(i) {
    step = Math.max(0, Math.min(STEPS.length - 1, i));
    if (WELCOME && STEPS[step].id === 'done') { st.setupDone = true; save(true); }
    draw(true);
  }

  // ---------- events ----------
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset.set) {
      st[t.dataset.set] = t.value; save();
      if (t.dataset.set === 'theme') applyTheme();
      if (t.dataset.set === 'termWord') draw();
    } else if (t.dataset.classField) {
      const c = st.classes[+t.closest('[data-class]').dataset.class];
      if (c) { c[t.dataset.classField] = t.value; save(); }
    }
    else if (t.dataset.study) { st.study[t.dataset.study] = t.type === 'number' || t.tagName === 'SELECT' ? Number(t.value) : t.value; save(); }
    else if (t.dataset.studyFlag) { st.study[t.dataset.studyFlag] = t.checked; save(); }
    else if (t.dataset.termField) {
      const i = +t.closest('[data-term]').dataset.term;
      if (!st.semesters.terms[i]) st.semesters.terms[i] = { name: `${word()} ${i + 1}`, start: '', weeks: 11, breakWeeks: [] };
      const term = st.semesters.terms[i];
      const f = t.dataset.termField;
      term[f] = f === 'weeks' ? Number(t.value) : f === 'breakWeeks' ? t.value.split(/[^0-9]+/).filter(Boolean).map(Number) : t.value;
      st.semesters.mode = 'manual';
      save();
    } else if (t.dataset.act === 'code') { setModule(t.dataset.name, { code: t.value.trim() }); }
    else if (t.dataset.act === 'hide') { setModule(t.dataset.name, { hidden: t.checked }); draw(); }
    else if (t.name === 'semmode') { st.semesters.mode = t.value; save(); draw(); }
    else if (t.dataset.pref) {
      prefs[t.dataset.pref] = t.checked;
      if (api()) Promise.resolve(api().set_pref(t.dataset.pref, t.checked)).then((r) => { if (r && r.error) alert(r.error); }).catch(console.error);
    }
  });

  document.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-step], [data-act]');
    if (!b) return;
    if (b.dataset.step != null) { go(+b.dataset.step); return; }
    const act = b.dataset.act;
    if (act === 'next') go(step + 1);
    else if (act === 'back') go(step - 1);
    else if (act === 'close') { save(true); if (api()) api().close_settings(); }
    else if (act === 'open') { save(true); if (api()) api().open_dashboard(); }
    else if (act === 'data-file' && api()) api().open_data_file();
    else if (act === 'test-note' && api()) api().test_notification();
    else if (act === 'link' || act === 'unlink') {
      const kind = b.dataset.kind;
      const input = $(`[data-link="${kind}"]`);
      const value = act === 'unlink' ? '' : (input ? input.value.trim() : '');
      if (act === 'link' && !value) { if (input) input.focus(); return; }
      if (!api()) return;
      const r = await api().set_links(kind === 'learn' ? value : null, kind === 'timetable' ? value : null);
      if (r && r.error) { alert(r.error); return; }
      checking[kind] = act === 'link' ? Date.now() : 0;
      if (feeds[kind]) feeds[kind] = { ...feeds[kind], updated: '', ok: false, error: '' };
      links = await api().get_links();
      draw();
      pollFeeds();
    } else if (act === 'term-add') {
      st.semesters.mode = 'manual';
      st.semesters.terms.push({ name: `${word()} ${st.semesters.terms.length + 1}`, start: '', weeks: 11, breakWeeks: [] });
      save(); draw();
    } else if (act === 'term-remove') {
      st.semesters.terms.splice(+b.dataset.i, 1);
      save(); draw();
    } else if (act === 'colour') { setModule(b.dataset.name, { color: b.dataset.colour }); draw(); }
    else if (act === 'mod-add') {
      const name = $('#newModName').value.trim();
      const code = $('#newModCode').value.trim();
      if (!name) { $('#newModName').focus(); return; }
      setModule(name, { manual: true, code: code || abbrev(name) });
      draw();
    } else if (act === 'class-add') {
      // A new row starts like the last one, a day later: quicker for a course's lectures.
      const last = st.classes[st.classes.length - 1];
      const nextDay = last ? WEEK_DAYS[(WEEK_DAYS.findIndex(([v]) => v === last.day) + 1) % 5][0] : 'mon';
      st.classes.push(last ? { ...last, day: nextDay } : { module: '', type: 'Lecture', day: 'mon', start: '09:00', end: '10:00', room: '' });
      save(); draw();
      const rows = document.querySelectorAll('[data-class]');
      if (rows.length) rows[rows.length - 1].querySelector('select').focus();
    } else if (act === 'class-remove') {
      st.classes.splice(+b.dataset.i, 1);
      save(); draw();
    } else if (act === 'ics-file') {
      if (!api()) return;
      const kind = b.dataset.kind;
      const r = await api().use_ics_file(kind);
      if (!r || r.cancelled) return;
      if (r.error) { alert(r.error); return; }
      checking[kind] = Date.now();
      if (feeds[kind]) feeds[kind] = { ...feeds[kind], updated: '', ok: false, error: '' };
      links = await api().get_links();
      draw();
      pollFeeds();
    } else if (act === 'mod-remove') {
      st.modules = st.modules.filter((m) => m.name.toLowerCase() !== b.dataset.name.toLowerCase());
      save(); draw();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('[data-link]')) {
      e.preventDefault();
      const btn = $(`[data-act="link"][data-kind="${e.target.dataset.link}"]`);
      if (btn) btn.click();
    }
  });

  // Calendar checks: the app syncs in the background; look again until it's done.
  let pollTimer = 0;
  function pollFeeds() {
    clearTimeout(pollTimer);
    const tick = async () => {
      if (!api()) return;
      try { feeds = (await api().get_feeds()) || {}; } catch (err) { return; }
      const waiting = ['learn', 'timetable'].some((k) => checking[k] && Date.now() - checking[k] < 30000 && !(feeds[k] && (feeds[k].updated && feeds[k].ok || feeds[k].error)));
      if (['calendars', 'semesters', 'modules', 'done'].includes(STEPS[step].id)) draw();
      if (waiting) pollTimer = setTimeout(tick, 1500);
    };
    pollTimer = setTimeout(tick, 1200);
  }
  window.onFeedsUpdated = () => pollFeeds();

  // ---------- theme ----------
  let systemTheme = null;
  function applyTheme() {
    const wanted = st.theme || 'auto';
    const dark = systemTheme ? !!systemTheme.dark : !window.matchMedia('(prefers-color-scheme: light)').matches;
    const name = wanted === 'auto' ? (dark ? 'windows-dark' : 'windows-light') : wanted;
    document.documentElement.dataset.theme = name;
    const accent = !systemTheme ? null : name === 'windows-dark' ? systemTheme.accentLight : name === 'windows-light' ? systemTheme.accentDark : null;
    if (/^#[0-9a-f]{6}$/i.test(accent || '')) document.documentElement.style.setProperty('--accent', accent);
    else document.documentElement.style.removeProperty('--accent');
  }

  // ---------- start ----------
  async function start() {
    const a = api();
    let saved = {};
    if (a) {
      try {
        [saved, platform, prefs, links, feeds, systemTheme] = await Promise.all([
          a.get_settings(), a.get_platform(), a.get_prefs(), a.get_links(), a.get_feeds(), a.get_system_theme()]);
      } catch (err) { console.error(err); }
    }
    if (platform && platform.welcome) WELCOME = true;
    STEPS = makeSteps();
    document.title = WELCOME ? 'Set up Studeck' : 'Studeck settings';
    st = defaults(saved);
    applyTheme();
    draw(true);
  }
  if (window.pywebview && window.pywebview.api) start();
  else window.addEventListener('pywebviewready', start);
  // Opened in a normal browser (no app): show the pages with sample values.
  setTimeout(() => { if (!api() && !$('#page').innerHTML) start(); }, 400);
})();
