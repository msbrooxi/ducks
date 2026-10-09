// Do Next, "I have X minutes", and the five-ducks fill. Every rule here is
// meant to be easy to re-tune from Settings without touching this file's
// shape (the numbers all come from the settings object).

import { isPastDue, ducksDayDate } from './store.js?v=2026-10-09.2';

function daysUntil_(dueStr, today) {
  if (!dueStr) return Infinity;
  const [y1, m1, d1] = today.split('-').map(Number);
  const [y2, m2, d2] = dueStr.split('-').map(Number);
  const a = Date.UTC(y1, m1 - 1, d1);
  const b = Date.UTC(y2, m2 - 1, d2);
  return Math.round((b - a) / 86400000);
}

export function score(task, settings, today = ducksDayDate()) {
  const s = (settings.rankSlider ?? 50) / 100;
  const importance = (task.ducks ?? 2) / 5;
  const days = daysUntil_(task.due, today);
  let urgency = 0;
  if (task.due) {
    if (days <= 0) urgency = 1;
    else urgency = Math.max(0, 1 - days / 14);
  }
  return (1 - s) * urgency + s * importance;
}

function isDueSoon_(task, settings, today) {
  if (!task.due) return false;
  const days = daysUntil_(task.due, today);
  return days >= 0 && days <= (settings.dueSoonDays ?? 3);
}

function isQuickWin_(task, settings) {
  return !!task.size && (settings.quickWinSizes || ['S']).includes(task.size);
}

// A task with an unfinished pre-req is blocked: it stays visible in the
// List tab (with a "blocked by" note) so it isn't invisible data, but it
// never counts as something to do right now. A deleted pre-req no longer
// blocks anything, there's nothing left to wait on.
export function isBlocked(task, byId) {
  if (!task.dependsOn || !task.dependsOn.length) return false;
  return task.dependsOn.some((depId) => {
    const dep = byId[depId];
    return dep && !dep.deletedAt && dep.status !== 'done';
  });
}
function byId_(tasks) {
  const map = {};
  for (const t of tasks) map[t.id] = t;
  return map;
}

export function doNextList(tasks, settings, today = ducksDayDate(), count = 5) {
  const byId = byId_(tasks);
  // A project "head" task (has a chip) is a container, not something to do
  // directly, so it never appears in Do Next; only its steps do. A blocked
  // task (an unfinished pre-req) doesn't count as something to do yet either.
  const active = tasks.filter((t) => !t.deletedAt && t.status !== 'done' && !t.chip && !isBlocked(t, byId));
  const pastDue = active.filter((t) => isPastDue(t, today))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  const slots = [];
  const used = new Set();
  for (const t of pastDue) {
    if (slots.length >= count) break;
    slots.push(t); used.add(t.id);
  }

  if (slots.length < count) {
    const notPastDue = active.filter((t) => !used.has(t.id) && !isPastDue(t, today));
    const lanes = [
      (t) => isDueSoon_(t, settings, today) && !isPastDue(t, today),
      (t) => (t.ducks ?? 0) >= 4 && !isDueSoon_(t, settings, today),
      (t) => isQuickWin_(t, settings)
    ];
    for (const laneFn of lanes) {
      if (slots.length >= count) break;
      const candidates = notPastDue.filter((t) => laneFn(t) && !used.has(t.id))
        .sort((a, b) => score(b, settings, today) - score(a, settings, today));
      if (candidates[0]) { slots.push(candidates[0]); used.add(candidates[0].id); }
    }
  }

  if (slots.length < count) {
    const rest = active.filter((t) => !used.has(t.id))
      .sort((a, b) => score(b, settings, today) - score(a, settings, today));
    for (const t of rest) {
      if (slots.length >= count) break;
      slots.push(t); used.add(t.id);
    }
  }

  return slots;
}

export function minutesFilter(tasks, minutes, settings) {
  const byId = byId_(tasks);
  const active = tasks.filter((t) => !t.deletedAt && t.status !== 'done' && !t.chip && !isBlocked(t, byId));
  const sizeMinutes = settings.sizeMinutes || { S: 15, M: 30, L: 60 };
  const fits = active.filter((t) => t.size && sizeMinutes[t.size] != null && sizeMinutes[t.size] <= minutes);
  const hiddenUnsized = active.filter((t) => !t.size || t.size === 'XL').length;
  fits.sort((a, b) => score(b, settings) - score(a, settings));
  return { fits, hiddenUnsized };
}

// ---- List tab sorting (separate from the Do Next scoring above) ----

const SIZE_ORDER = { XS: 0, S: 1, M: 2, L: 3, XL: 4 };

function compareDue_(a, b) {
  if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
  if (a.due) return -1; // has a date beats no date
  if (b.due) return 1;
  return 0;
}
function compareDucksDesc_(a, b) {
  const da = a.ducks ?? -1, db = b.ducks ?? -1; // unrated sinks to the bottom
  return db - da;
}
function compareCreatedAsc_(a, b) {
  return (a.createdAt || '') < (b.createdAt || '') ? -1 : (a.createdAt || '') > (b.createdAt || '') ? 1 : 0;
}

export const LIST_SORTS = [
  { id: 'date', label: 'Date' },
  { id: 'ducks', label: 'Ducks' },
  { id: 'duration', label: 'Duration' },
  { id: 'created', label: 'Recently added' }
];

// Each mode has a "natural" default direction (the one it used to be
// hardcoded to): soonest-first for date, most-ducks-first for ducks,
// shortest-first for duration, newest-first for recently-added. 'asc'/
// 'desc' here mean relative to that natural direction, not literally
// ascending/descending in every case, since "ascending ducks" read
// backwards from what the direction toggle should mean to her: the
// default state of every sort should be what it already was.
export const DEFAULT_SORT_DIR = { date: 'asc', ducks: 'desc', duration: 'asc', created: 'desc' };
export const SORT_DIR_LABELS = {
  date: { asc: 'Soonest first', desc: 'Latest first' },
  ducks: { asc: 'Fewest first', desc: 'Most first' },
  duration: { asc: 'Shortest first', desc: 'Longest first' },
  created: { asc: 'Oldest first', desc: 'Newest first' }
};

// 'date': soonest due date first, no date last (reversed: latest first).
// 'ducks': most ducks first by default, not-rated always last either way.
// 'duration': shortest t-shirt size first by default, no size last either
// way; ties broken by soonest due date.
// 'created': newest first by default (so "what did I just add" is a
// glance away), oldest first when reversed.
// A task with no value for the chosen field (no due date, no ducks, no
// size) always sinks to the bottom regardless of direction: there's no
// meaningful "last" vs "first" for a blank, and flipping that too would
// just be confusing.
export function sortForList(tasks, mode, direction = DEFAULT_SORT_DIR[mode] || 'asc') {
  let hasValue, cmp;
  if (mode === 'ducks') {
    hasValue = (t) => t.ducks != null;
    cmp = (a, b) => (a.ducks - b.ducks) || compareCreatedAsc_(a, b);
  } else if (mode === 'duration') {
    hasValue = (t) => !!t.size;
    cmp = (a, b) => (SIZE_ORDER[a.size] - SIZE_ORDER[b.size]) || compareDue_(a, b);
  } else if (mode === 'created') {
    hasValue = () => true;
    cmp = compareCreatedAsc_;
  } else {
    hasValue = (t) => !!t.due;
    cmp = (a, b) => compareDue_(a, b) || compareDucksDesc_(a, b);
  }
  const withValue = tasks.filter(hasValue).sort(cmp);
  const withoutValue = tasks.filter((t) => !hasValue(t));
  // Every comparator above is written in its own plain ascending sense
  // (fewest ducks, shortest duration, soonest date, oldest created first),
  // and the "Fewest/Shortest/Soonest/Oldest first" label in
  // SORT_DIR_LABELS always corresponds to direction === 'asc', so this is
  // just: asc uses the comparator as written, desc reverses it. Which
  // direction is pre-selected by default per mode (DEFAULT_SORT_DIR) is a
  // separate, UI-only concern handled by the caller.
  const ordered = direction === 'asc' ? withValue : withValue.reverse();
  return ordered.concat(withoutValue);
}

// Revised 2026-10-02: this used to weight each completed task's contribution
// by its t-shirt size (a quick XS task barely moved the meter, an XL task
// nearly filled it alone), which was a deliberate design call at the time
// but read as "the duck meter isn't properly filling" since it didn't match
// the plain expectation of one duck lighting up per task checked off.
// Simple count now: each task completed today fills one duck, flat, no
// weighting, and no cap: 5 is the daily floor the row always shows, not a
// ceiling on what this returns. fiveDucksRow() in main.js is what grows
// the row to fit whatever this reports, one duck past the actual count.
// Capping it here at 5 (left over from the old weighted version, which
// really did treat 5 as a hard max) silently truncated every count past 5
// back down to 5, which is why 6 completed tasks still showed as "5
// ducks" even after the row itself was changed to grow past 5.
export function fiveDucksFill(tasks, today = ducksDayDate()) {
  let count = 0;
  for (const t of tasks) {
    if (t.status !== 'done' || !t.completedAt) continue;
    if (ducksDayDate(new Date(t.completedAt)) !== today) continue;
    count += 1;
  }
  return count;
}
