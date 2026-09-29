// Local state: tasks, settings, and the small queue of not-yet-synced
// changes. Everything here is plain localStorage, no framework.

const LS_TASKS = 'ducks_tasks';       // { [id]: task }
const LS_SETTINGS = 'ducks_settings'; // synced settings object
const LS_LOCAL = 'ducks_local';       // per-device, never synced
const LS_DIRTY_TASKS = 'ducks_dirty_tasks';   // [id, ...]
const LS_DIRTY_SETTINGS = 'ducks_dirty_settings'; // bool
const LS_EVENT_QUEUE = 'ducks_event_queue';   // [event, ...] not yet confirmed synced
const LS_CONN = 'ducks_conn'; // { url, key }

export const CATEGORIES = [
  { id: 'admin', label: 'Admin' },
  { id: 'conversation', label: 'Conversation' },
  { id: 'deep', label: 'Deep work' },
  { id: 'decision', label: 'Decision' },
  { id: 'errand', label: 'Errand' },
  { id: 'money', label: 'Money and Filings' }
];

// Revised 2026-09-29: added XS, shifted the other thresholds up a notch.
export const SIZES = [
  { id: 'XS', label: 'XS (under 15 min)' },
  { id: 'S', label: 'S (under 30 min)' },
  { id: 'M', label: 'M (under 1 hr)' },
  { id: 'L', label: 'L (under 3 hr)' },
  { id: 'XL', label: 'XL (3+ hr)' }
];

const DEFAULT_SETTINGS = {
  rankSlider: 50,
  dueSoonDays: 3,
  quickWinSizes: ['XS'],
  sizeMinutes: { XS: 15, S: 30, M: 60, L: 180 },
  duckFillWeights: { XS: 0.15, S: 0.3, M: 0.5, L: 0.8, XL: 1 },
  dayStartHour: 3,
  updatedAt: '1970-01-01T00:00:00.000Z'
};

const DEFAULT_LOCAL = { muted: false, theme: 'auto' };

function readJson_(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function writeJson_(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    // storage full or blocked (private window); the app still works this
    // session, it just won't remember across a reload.
  }
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function nowIso() {
  return new Date().toISOString();
}

// ---- the "Ducks day" boundary: 3 AM America/New_York, everywhere ----

function easternParts_(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit'
  });
  const parts = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return { year: parts.year, month: parts.month, day: parts.day, hour: Number(parts.hour) };
}

// Returns 'YYYY-MM-DD' for the Ducks-day this instant belongs to: the
// calendar day in effect from 3 AM ET until 2:59 AM ET the next day.
export function ducksDayDate(date = new Date()) {
  const p = easternParts_(date);
  if (p.hour >= 3) return `${p.year}-${p.month}-${p.day}`;
  // Before 3 AM: still "yesterday" for Ducks purposes. Step back a real
  // calendar day using the date object, then re-read in Eastern time.
  const back = new Date(date.getTime() - 24 * 60 * 60 * 1000);
  const pb = easternParts_(back);
  return `${pb.year}-${pb.month}-${pb.day}`;
}

export function isPastDue(task, today = ducksDayDate()) {
  return !!task.due && task.due < today && task.status !== 'done';
}

// ---- tasks ----

export function getTasks() {
  return readJson_(LS_TASKS, {});
}
export function getTaskList() {
  return Object.values(getTasks()).filter((t) => !t.deletedAt);
}
export function getTask(id) {
  return getTasks()[id];
}
export function saveTask(task) {
  const tasks = getTasks();
  tasks[task.id] = task;
  writeJson_(LS_TASKS, tasks);
  markTaskDirty(task.id);
}
export function replaceAllTasks(list) {
  const tasks = {};
  for (const t of list) tasks[t.id] = t;
  writeJson_(LS_TASKS, tasks);
}

// Fields that get their own merge timestamp (see touchTask below). Keep this
// in sync with apps-script/Code.gs's per-field merge.
const CORE_FIELDS = [
  'title', 'notes', 'link', 'ducks', 'due', 'size', 'category',
  'status', 'doingSince', 'completedAt', 'deletedAt'
];

export function newTask(overrides = {}) {
  const ts = nowIso();
  const task = Object.assign({
    id: uuid(),
    title: '',
    notes: null,
    link: null,
    ducks: null,
    due: null,
    size: null,
    category: 'admin',
    status: 'active',
    doingSince: null,
    source: 'me',
    createdAt: ts,
    updatedAt: ts,
    completedAt: null,
    deletedAt: null
  }, overrides);
  task.fieldUpdatedAt = {};
  for (const f of CORE_FIELDS) task.fieldUpdatedAt[f] = ts;
  return task;
}

// Applies a patch to a task, bumping updatedAt and the per-field timestamp
// for exactly the fields touched. Two devices editing different fields on
// the same task (e.g. one rates ducks, the other changes the category)
// then merge cleanly instead of one stale whole-task copy overwriting the
// other's edit. Always use this instead of hand-rolling Object.assign.
export function touchTask(task, patch) {
  const ts = nowIso();
  const fieldUpdatedAt = Object.assign({}, task.fieldUpdatedAt);
  for (const key of Object.keys(patch)) {
    fieldUpdatedAt[key] = ts;
  }
  return Object.assign({}, task, patch, { updatedAt: ts, fieldUpdatedAt });
}

// ---- settings ----

export function getSettings() {
  const stored = readJson_(LS_SETTINGS, {});
  // sizeMinutes/duckFillWeights/quickWinSizes have no Settings-screen control
  // yet, so nothing has deliberately customized them. Always take the code
  // defaults for these three, otherwise an earlier save (e.g. dragging the
  // rank slider) would have quietly baked in the old size scheme forever,
  // since Object.assign doesn't merge inside nested objects.
  return Object.assign({}, DEFAULT_SETTINGS, stored, {
    sizeMinutes: DEFAULT_SETTINGS.sizeMinutes,
    duckFillWeights: DEFAULT_SETTINGS.duckFillWeights,
    quickWinSizes: DEFAULT_SETTINGS.quickWinSizes
  });
}
export function saveSettings(patch) {
  const settings = Object.assign(getSettings(), patch, { updatedAt: nowIso() });
  writeJson_(LS_SETTINGS, settings);
  localStorage.setItem(LS_DIRTY_SETTINGS, '1');
  return settings;
}
export function replaceSettings(settings) {
  writeJson_(LS_SETTINGS, settings);
}

// ---- device-local (never synced) ----

export function getLocal() {
  return Object.assign({}, DEFAULT_LOCAL, readJson_(LS_LOCAL, {}));
}
export function saveLocal(patch) {
  const local = Object.assign(getLocal(), patch);
  writeJson_(LS_LOCAL, local);
  return local;
}

// ---- connection (web app URL + this device's key) ----

export function getConn() {
  return readJson_(LS_CONN, { url: '', key: '' });
}
export function saveConn(conn) {
  writeJson_(LS_CONN, conn);
}

// ---- dirty tracking, for sync.js ----

export function markTaskDirty(id) {
  const dirty = new Set(readJson_(LS_DIRTY_TASKS, []));
  dirty.add(id);
  writeJson_(LS_DIRTY_TASKS, [...dirty]);
}
export function getDirtyTaskIds() {
  return readJson_(LS_DIRTY_TASKS, []);
}
export function clearDirtyTasks(ids) {
  const remaining = getDirtyTaskIds().filter((id) => !ids.includes(id));
  writeJson_(LS_DIRTY_TASKS, remaining);
}
export function isSettingsDirty() {
  return localStorage.getItem(LS_DIRTY_SETTINGS) === '1';
}
export function clearSettingsDirty() {
  localStorage.removeItem(LS_DIRTY_SETTINGS);
}

// ---- event log queue ----

export function logEvent(type, taskId, extra = {}) {
  const queue = readJson_(LS_EVENT_QUEUE, []);
  queue.push(Object.assign({ id: uuid(), ts: nowIso(), taskId, type, device: deviceName_() }, extra));
  writeJson_(LS_EVENT_QUEUE, queue);
}
export function getEventQueue() {
  return readJson_(LS_EVENT_QUEUE, []);
}
export function clearEventQueue(ids) {
  const remaining = getEventQueue().filter((e) => !ids.includes(e.id));
  writeJson_(LS_EVENT_QUEUE, remaining);
}
function deviceName_() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iphone';
  if (/Android/.test(ua)) return 'android';
  return 'laptop';
}
