// Do Next, "I have X minutes", and the five-ducks fill. Every rule here is
// meant to be easy to re-tune from Settings without touching this file's
// shape (the numbers all come from the settings object).

import { isPastDue, ducksDayDate } from './store.js';

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

export function doNextList(tasks, settings, today = ducksDayDate()) {
  // A project "head" task (has a chip) is a container, not something to do
  // directly, so it never appears in Do Next; only its steps do.
  const active = tasks.filter((t) => !t.deletedAt && t.status !== 'done' && !t.chip);
  const pastDue = active.filter((t) => isPastDue(t, today))
    .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));

  const slots = [];
  const used = new Set();
  for (const t of pastDue) {
    if (slots.length >= 3) break;
    slots.push(t); used.add(t.id);
  }

  if (slots.length < 3) {
    const notPastDue = active.filter((t) => !used.has(t.id) && !isPastDue(t, today));
    const lanes = [
      (t) => isDueSoon_(t, settings, today) && !isPastDue(t, today),
      (t) => (t.ducks ?? 0) >= 4 && !isDueSoon_(t, settings, today),
      (t) => isQuickWin_(t, settings)
    ];
    for (const laneFn of lanes) {
      if (slots.length >= 3) break;
      const candidates = notPastDue.filter((t) => laneFn(t) && !used.has(t.id))
        .sort((a, b) => score(b, settings, today) - score(a, settings, today));
      if (candidates[0]) { slots.push(candidates[0]); used.add(candidates[0].id); }
    }
  }

  if (slots.length < 3) {
    const rest = active.filter((t) => !used.has(t.id))
      .sort((a, b) => score(b, settings, today) - score(a, settings, today));
    for (const t of rest) {
      if (slots.length >= 3) break;
      slots.push(t); used.add(t.id);
    }
  }

  return slots;
}

export function minutesFilter(tasks, minutes, settings) {
  const active = tasks.filter((t) => !t.deletedAt && t.status !== 'done' && !t.chip);
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

export const LIST_SORTS = [
  { id: 'date', label: 'Date' },
  { id: 'ducks', label: 'Ducks' },
  { id: 'duration', label: 'Duration' }
];

// 'date': soonest due date first, no date last.
// 'ducks': most ducks first, not-rated last.
// 'duration': shortest t-shirt size first, no size last; ties broken by
// soonest due date, for banging out a bunch of little tasks when there's
// spare time.
export function sortForList(tasks, mode) {
  const list = tasks.slice();
  if (mode === 'ducks') {
    list.sort((a, b) => compareDucksDesc_(a, b) || compareDue_(a, b));
  } else if (mode === 'duration') {
    list.sort((a, b) => {
      const sa = a.size ? SIZE_ORDER[a.size] : 99;
      const sb = b.size ? SIZE_ORDER[b.size] : 99;
      return sa !== sb ? sa - sb : compareDue_(a, b);
    });
  } else {
    list.sort((a, b) => compareDue_(a, b) || compareDucksDesc_(a, b));
  }
  return list;
}

export function fiveDucksFill(tasks, settings, today = ducksDayDate()) {
  const weights = settings.duckFillWeights || { S: 0.25, M: 0.5, L: 0.75, XL: 1 };
  let total = 0;
  for (const t of tasks) {
    if (t.status !== 'done' || !t.completedAt) continue;
    if (ducksDayDate(new Date(t.completedAt)) !== today) continue;
    total += weights[t.size || 'L'] ?? weights.L;
  }
  return Math.min(5, total);
}
