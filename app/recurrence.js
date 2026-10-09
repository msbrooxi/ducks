// Date math for recurring tasks. Six frequencies: "weekly" and "biweekly"
// (a fixed day of the week, every 1 or 2 weeks), "monthly" (a fixed day of
// every month, e.g. mortgage deposits on the 1st), "quarterly" (a fixed day
// counted from the start of each calendar quarter, e.g. day 20 of the
// quarter, so Jan 20 / Apr 20 / Jul 20 / Oct 20), "annually" (a fixed month
// and day each year), and "interval" (every N days/weeks/months, counted
// from whenever the task was last completed, not anchored to any fixed
// calendar position the way the others are, added 2026-10-09 for things
// like "every 90 days" that don't line up with a fixed weekday or date).
//
// A recurring task keeps only ONE live instance at a time. Completing it
// spawns the next one (see completeTask() in main.js); there is no
// separate "series" object. recurrence shapes, stored right on the task
// (see store.js's CORE_FIELDS):
//   weekly/biweekly: { freq, day: 0..6 }        (0 = Sunday, per getUTCDay())
//   monthly/quarterly: { freq, day: 1..31 }
//   annually: { freq, month: 1..12, day: 1..31 }
//   interval: { freq: 'interval', unit: 'days'|'weeks'|'months', n: 1+ }

export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function daysInMonth_(year, monthIndex0) {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

function monthlyOccurrence_(year, monthIndex0, day) {
  const d = Math.min(day, daysInMonth_(year, monthIndex0));
  return `${year}-${String(monthIndex0 + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInQuarter_(year, quarterIndex0) {
  const startMonth = quarterIndex0 * 3;
  const start = Date.UTC(year, startMonth, 1);
  const end = Date.UTC(year, startMonth + 3, 1);
  return Math.round((end - start) / 86400000);
}

// Quarter index 0..3 (0 = Jan-Mar). "Day N of the quarter" counts the
// quarter's first calendar day as day 1. Clamped to however many days that
// particular quarter actually has (90-92, depending on which quarter and
// leap years), the same way monthlyOccurrence_ clamps "day 31" down to the
// 28th/29th/30th in a shorter month, rather than silently overflowing into
// the next quarter.
function quarterlyOccurrence_(year, quarterIndex0, day) {
  const startMonth = quarterIndex0 * 3;
  const clamped = Math.min(day, daysInQuarter_(year, quarterIndex0));
  const d = new Date(Date.UTC(year, startMonth, 1));
  d.setUTCDate(d.getUTCDate() + (clamped - 1));
  return d.toISOString().slice(0, 10);
}

// month is 1-12 here (not an index), matching how it's stored on the task.
function annualOccurrence_(year, month, day) {
  return monthlyOccurrence_(year, month - 1, day);
}

// Adds n calendar months, clamping the day-of-month to whatever the
// resulting month actually has (same clamping monthlyOccurrence_ already
// does), so "every 1 month" from Jan 31 lands on Feb 28/29, not March 3.
function addMonthsToDateStr_(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const total0 = (m - 1) + n;
  const year = y + Math.floor(total0 / 12);
  const month0 = ((total0 % 12) + 12) % 12;
  return monthlyOccurrence_(year, month0, d);
}

function addDaysToDateStr_(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}
function weekdayOf_(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
function nextWeekdayOnOrAfter_(dateStr, weekday) {
  let d = dateStr;
  while (weekdayOf_(d) !== weekday) d = addDaysToDateStr_(d, 1);
  return d;
}

// 'kind' tells main.js which input fields to show for this frequency:
// 'weekday' = a day-of-week picker, 'dayOfMonth' = a day number input,
// 'monthDay' = a month picker plus a day number input. 'maxDay' is that
// number input's actual valid range: a month never has more than 31 days,
// but a quarter has up to 92, and the day input used to be hardcoded to
// max="31" for every "dayOfMonth" frequency, which made it impossible to
// set up a quarterly task on, say, day 37 (entering "file the sales tax
// report on the 37th day of the quarter" is exactly the kind of thing this
// frequency exists for). Listed in increasing duration order.
export const FREQUENCIES = [
  { id: 'weekly', label: 'Weekly', kind: 'weekday', dayHint: 'Day of the week' },
  { id: 'biweekly', label: 'Every 2 weeks', kind: 'weekday', dayHint: 'Day of the week' },
  { id: 'monthly', label: 'Monthly', kind: 'dayOfMonth', dayHint: 'Day of the month (1-31)', maxDay: 31 },
  { id: 'quarterly', label: 'Quarterly', kind: 'dayOfMonth', dayHint: "Day of the quarter, counting the quarter's first day as day 1 (up to 92; past the quarter's actual last day rounds down to it)", maxDay: 92 },
  { id: 'annually', label: 'Annually', kind: 'monthDay', dayHint: 'Day of the month (1-31)', maxDay: 31 },
  // Not anchored to a fixed weekday/date like the others above: counts N
  // units forward from the date just completed. "Every 90 days" or "every
  // 6 months" (a maintenance interval, a checkup cadence) doesn't line up
  // with a fixed calendar position the way "the 1st" or "Mondays" does.
  { id: 'interval', label: 'Every X days/weeks/months', kind: 'interval' }
];

// The next occurrence strictly after afterDateStr's period, ignoring
// whatever day-of-month/weekday afterDateStr itself falls on. Always steps
// forward exactly one period from the rule, so completing a task early or
// late never shifts the schedule.
export function computeNextDue(recurrence, afterDateStr) {
  if (!recurrence || !afterDateStr) return null;
  const [y, m] = afterDateStr.split('-').map(Number);

  if (recurrence.freq === 'weekly') return addDaysToDateStr_(afterDateStr, 7);
  if (recurrence.freq === 'biweekly') return addDaysToDateStr_(afterDateStr, 14);
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
  if (recurrence.freq === 'annually') {
    return annualOccurrence_(y + 1, recurrence.month, recurrence.day);
  }
  if (recurrence.freq === 'interval') {
    const n = recurrence.n || 1;
    if (recurrence.unit === 'days') return addDaysToDateStr_(afterDateStr, n);
    if (recurrence.unit === 'weeks') return addDaysToDateStr_(afterDateStr, n * 7);
    if (recurrence.unit === 'months') return addMonthsToDateStr_(afterDateStr, n);
    return null;
  }
  return null;
}

// The soonest occurrence on or after todayStr, used when first creating a
// recurring task (so setting up "monthly on the 12th" on the 5th gives you
// this month's 12th, not next month's).
export function computeFirstDue(recurrence, todayStr) {
  if (!recurrence || !todayStr) return null;
  const [y, m] = todayStr.split('-').map(Number);

  if (recurrence.freq === 'weekly' || recurrence.freq === 'biweekly') {
    return nextWeekdayOnOrAfter_(todayStr, recurrence.day);
  }
  if (recurrence.freq === 'monthly') {
    const candidate = monthlyOccurrence_(y, m - 1, recurrence.day);
    return candidate >= todayStr ? candidate : computeNextDue(recurrence, candidate);
  }
  if (recurrence.freq === 'quarterly') {
    const q = Math.floor((m - 1) / 3);
    const candidate = quarterlyOccurrence_(y, q, recurrence.day);
    return candidate >= todayStr ? candidate : computeNextDue(recurrence, candidate);
  }
  if (recurrence.freq === 'annually') {
    const candidate = annualOccurrence_(y, recurrence.month, recurrence.day);
    return candidate >= todayStr ? candidate : annualOccurrence_(y + 1, recurrence.month, recurrence.day);
  }
  if (recurrence.freq === 'interval') {
    // No fixed calendar position to find the "next" occurrence of, unlike
    // the others above: the first instance of an interval recurrence is
    // just whenever it's created, and it counts forward N units from there
    // (and from each completion after that).
    return todayStr;
  }
  return null;
}

export function recurrenceLabel(recurrence) {
  if (!recurrence) return '';
  if (recurrence.freq === 'weekly') return `Weekly on ${WEEKDAY_NAMES[recurrence.day]}`;
  if (recurrence.freq === 'biweekly') return `Every 2 weeks on ${WEEKDAY_NAMES[recurrence.day]}`;
  if (recurrence.freq === 'monthly') return `Monthly on day ${recurrence.day}`;
  if (recurrence.freq === 'quarterly') return `Quarterly on day ${recurrence.day}`;
  if (recurrence.freq === 'annually') return `Annually on ${MONTH_NAMES[recurrence.month - 1]} ${recurrence.day}`;
  if (recurrence.freq === 'interval') {
    const n = recurrence.n || 1;
    const unitLabel = { days: 'day', weeks: 'week', months: 'month' }[recurrence.unit] || recurrence.unit;
    return n === 1 ? `Every ${unitLabel}` : `Every ${n} ${unitLabel}s`;
  }
  return '';
}
