// =====================================================================
//  SAMPLE DASHBOARD DATA - what the dashboard shows before it's set up.
//
//  You don't need to edit this: the setup window (it opens the first time,
//  and later from the gear on the dashboard or the tray / menu bar icon)
//  covers your name, calendars, semesters, modules and preferences.
//
//  ADVANCED: your own weekly classes, to-dos and extra coursework can go in
//  my-data.js - tray / menu bar icon > "Edit my data file (advanced)" makes
//  it as a copy of this file (it's kept out of git). Once my-data.js exists
//  the dashboard reads it instead of this file, and refreshes when you save.
//  Settings from the setup window take priority over the same things here.
//
//  Rules that keep it working:
//   • Dates are "YYYY-MM-DD"      e.g. "2026-10-23"
//   • Times are 24-hour "HH:MM"   e.g. "09:00", "14:30"
//   • Every item in a list ends with a comma, and text goes in "quotes".
//   • "module" must match one of the module codes below.
//   • Colours: coral, amber, mint, sky, violet, rose, lime, slate
//     (or a hex code like "#ff8f78").
//
//  Ticking things off on the dashboard is remembered separately, so you
//  don't need to edit this file to mark a task done.
// =====================================================================

// Sample dates are counted from today so the example never goes out of date.
// In your own file, just write dates like "2026-10-23".
var inDays = function (n) {
  var d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
};

window.DASHBOARD_DATA = {
  // Shows a "Sample data" badge. Set to false once this is your own data.
  sample: true,

  // Shown in the greeting ("Good morning, Alex"). Leave "" for none.
  name: "",

  // Colours: "auto" (match Windows light/dark + your accent colour),
  // "windows-dark", "windows-light", "sage", "sand" or "midnight".
  theme: "auto",

  // Your teaching weeks. With a start date the dashboard shows "Week 4 of 11"
  // and leaves weekly classes out of break weeks. Leave start "" to skip it.
  semester: {
    name: "Semester 1",
    start: "",             // Monday of teaching week 1, e.g. "2026-09-21"
    teachingWeeks: 11,
    breakWeeks: [],        // week numbers with no classes, e.g. [6]
  },

  // Your courses. Their names are matched against timetable and deadline items
  // to colour them. You can add credits: 10 / 20 to each, and
  // match: ["INFR....", "nickname"] if a course shows up under a different name.
  modules: [
    { code: "MOD1", name: "Example Module One",   color: "coral" },
    { code: "MOD2", name: "Example Module Two",   color: "sky" },
    { code: "MOD3", name: "Example Module Three", color: "violet" },
    { code: "MOD4", name: "Example Module Four",  color: "mint" },
  ],

  // Weekly classes (day: "mon".."sun") and one-off events (date: "YYYY-MM-DD").
  // Once your uni timetable link is connected it replaces the weekly ones,
  // so you can leave this empty.
  schedule: [
    { day: "mon", start: "10:00", end: "11:00", title: "Lecture", module: "MOD1", room: "Lecture Theatre 1" },
    { day: "tue", start: "14:00", end: "15:00", title: "Tutorial", module: "MOD2", room: "Room 2.14" },
    { day: "wed", start: "09:00", end: "11:00", title: "Lab", module: "MOD3", room: "Computer Lab" },
    { day: "thu", start: "12:00", end: "13:00", title: "Lecture", module: "MOD4", room: "Lecture Theatre 2" },
    { day: "fri", start: "11:00", end: "12:00", title: "Lecture", module: "MOD1", room: "Lecture Theatre 1" },
    // { date: "2026-10-28", start: "18:00", end: "19:00", title: "Hackathon", room: "Student Union" },
  ],

  // Your own to-dos. Each needs a unique id.
  tasks: [
    { id: "t1", title: "Read this week's lecture notes", module: "MOD1", due: inDays(1) },
    { id: "t2", title: "Do the tutorial sheet",          module: "MOD2", due: inDays(2) },
    { id: "t3", title: "Email my personal tutor",                        due: inDays(4) },
  ],

  // Deadlines from your learning site's calendar appear automatically. Add
  // coursework that isn't on it here. To give one of its deadlines a weight
  // and progress bar, add it here with exactly the same title (and the right
  // module code - those calendars don't say which course a deadline is for).
  // Sample coursework is hidden once real deadlines are coming in.
  coursework: [
    { id: "c1", title: "Coursework 1", module: "MOD1", due: inDays(5),  time: "12:00", weight: 25, progress: 40 },
    { id: "c2", title: "Lab report",   module: "MOD3", due: inDays(9),  time: "16:00", weight: 10, progress: 0 },
    { id: "c3", title: "Essay draft",  module: "MOD4", due: inDays(16), time: "12:00", weight: 30, progress: 10 },
  ],

  // The Study page (Uni | Life | Study): what's playing in Spotify (or any app
  // in Windows' media pop-up) with its buttons, and a focus (Pomodoro) timer.
  study: {
    focusMinutes: 25,           // your usual focus length (25, 50 and 90 are there too)
    breakMinutes: 5,
    dailyGoalMinutes: 120,      // daily focus goal for the streak (0 = no goal)
    miniTimer: true,            // small floating timer in the corner while the timer runs
  },
};
