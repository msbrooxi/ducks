// Date math for recurring tasks. Two frequencies for now, matching what
// Stephanie actually needs: "monthly" (a fixed day of every month, e.g.
// mortgage deposits on the 1st) and "quarterly" (a fixed day counted from
// the start of each calendar quarter, e.g. day 20 of the quarter, so
// Jan 20 / Apr 20 / Jul 20 / Oct 20).
//
// A recurring task keeps only ONE live instance at a time. Completing it
// spawns the next one (see completeTask() in main.js); there is no
// separate "series" object. recurrence = { freq: 'monthly'|'quarterly',
// day: 1..31 }, stored right on the task (see store.js's CORE_FIELDS).

function daysInMonth_(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

function monthlyOccurrence_(year, monthIndex0, day) {
  const d = Math.min(day, daysInMonth_(year, monthIndex0));
  return `${year}-${String(monthIndex0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Quarter index 0..3 (0 = Jan-Mar). "Day N of the quarter" counts the
// quarter's first calendar day as day 1.
function quarterlyOccurrence_(year, quarterIndex0, day) {
  const startMonth = quarterIndex0 * 3;
  const d = new Date(Date.UTC(year, startMonth, 1));
  d.setUTCDate(d.getUTCDate() + (day - 1));
  return d.toISOString().slice(0, 10);
}

export const FREQUENCIES = [
  { id: 'monthly', label: 'Monthly', dayHint: 'Day of the month (1-31)' },
  { id: 'quarterly', label: 'Quarterly', dayHint: "Day of the quarter, counting the quarter's first day as day 1" }
];

// The next occurrence strictly after afterDateStr's period, ignoring
// whatever day-of-month afterDateStr itself falls on. Always steps forward
// exactly one period from the rule, so completing a task early or late
// never shifts the schedule.
export function computeNextDue(recurrence, afterDateStr) {
  if (!recurrence || !afterDateStr) return null;
  const [y, m] = afterDateStr.split('-').map(Number);

  if (recurrence.freq === 'monthly') {
    let year = y, month0 = m - 1 + 1;
    if (month0 > 11) { month0 = 0; year += 1; }
    return monthlyOccurrence_(year, month0, recurrence.day);
  }
  if (recurrence.freq === 'quarterly') {
    let year = y, q = Math.floor((m - 1) / 3) + 1;
    if (q > 3) { q = 0; year += 1; }
    return quarterlyOccurrence_(year, q, recurrence.day);
  }
  return null;
}

// The soonest occurrence on or after todayStr, used when first creating a
// recurring task (so setting up "monthly on the 12th" on the 5th gives you
// this month's 12th, not next month's).
export function computeFirstDue(recurrence, todayStr) {
  if (!recurrence || !todayStr) return null;
  const [y, m] = todayStr.split('-').map(Number);

  if (recurrence.freq === 'monthly') {
    const candidate = monthlyOccurrence_(y, m - 1, recurrence.day);
    return candidate >= todayStr ? candidate : computeNextDue(recurrence, candidate);
  }
  if (recurrence.freq === 'quarterly') {
    const q = Math.floor((m - 1) / 3);
    const candidate = quarterlyOccurrence_(y, q, recurrence.day);
    return candidate >= todayStr ? candidate : computeNextDue(recurrence, candidate);
  }
  return null;
}

export function recurrenceLabel(recurrence) {
  if (!recurrence) return '';
  if (recurrence.freq === 'monthly') return `Monthly on day ${recurrence.day}`;
  if (recurrence.freq === 'quarterly') return `Quarterly on day ${recurrence.day}`;
  return '';
}
