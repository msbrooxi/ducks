// Talks to the Apps Script backend. One action, "sync": send whatever
// changed locally, get back the merged full state.

import {
  getConn, getTasks, replaceAllTasks, getSettings, replaceSettings,
  getDirtyTaskIds, clearDirtyTasks, markTaskDirty, isSettingsDirty, clearSettingsDirty,
  getEventQueue, clearEventQueue, backfillFieldUpdatedAt
} from './store.js?v=2026-10-03.2';

let pushTimer = null;
let syncing = false;
let listeners = [];

export function onSyncStatus(fn) {
  listeners.push(fn);
}
function announce_(status, detail) {
  for (const fn of listeners) fn(status, detail);
}

function fingerprint_(tasks) {
  return tasks.map((t) => t.id + ':' + t.updatedAt).sort().join('|');
}

export function scheduleSync(delayMs = 2000) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, delayMs);
}

export async function syncNow() {
  const { url, key } = getConn();
  if (!url || !key) {
    announce_('unconfigured');
    return { ok: false, error: 'not configured' };
  }
  if (syncing) return { ok: false, error: 'already syncing' };
  syncing = true;
  announce_('syncing');

  const tasksById = getTasks();
  const dirtyIds = getDirtyTaskIds();
  const dirtyTasks = dirtyIds.map((id) => tasksById[id]).filter(Boolean);
  const settingsDirty = isSettingsDirty();
  const events = getEventQueue();

  const payload = { key, action: 'sync', tasks: dirtyTasks, events };
  if (settingsDirty) payload.settings = getSettings();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'sync failed');

    // Any task pulled down missing a per-field timestamp for one or more
    // fields (whole task, or just some fields, e.g. one rated for ducks
    // before this existed but never touched on category) is still exposed
    // to the old whole-task-overwrite bug for exactly those fields. Stamp
    // a baseline now and re-mark it dirty so the fix pushes back up on its
    // own, instead of waiting for that field to happen to get edited again.
    const backfilledIds = [];
    const incomingTasks = (data.tasks || []).map((t) => {
      const stamped = backfillFieldUpdatedAt(t);
      if (stamped !== t) backfilledIds.push(t.id);
      return stamped;
    });

    // Did this pull actually change anything the screen could be showing?
    // A background sync (periodic, or on focus) used to silently replace
    // the local data with no way for main.js to know it should refresh,
    // meaning the screen could go stale relative to reality: tapping
    // "Done" on a task that's already been removed or changed underneath
    // it would find nothing to update and do nothing, silently. Comparing
    // a cheap fingerprint lets the caller re-render only when something
    // genuinely changed, not on every empty 60-second poll.
    const before = fingerprint_(Object.values(tasksById));
    const after = fingerprint_(incomingTasks);

    replaceAllTasks(incomingTasks);
    if (data.settings) replaceSettings(data.settings);
    clearDirtyTasks(dirtyIds);
    if (settingsDirty) clearSettingsDirty();
    clearEventQueue(events.map((e) => e.id));

    if (backfilledIds.length > 0) {
      backfilledIds.forEach(markTaskDirty);
      scheduleSync(500);
    }

    announce_('ok', { changed: before !== after });
    return { ok: true };
  } catch (err) {
    announce_('error', String(err));
    return { ok: false, error: String(err) };
  } finally {
    syncing = false;
  }
}

export async function exportEventLog() {
  const { url, key } = getConn();
  if (!url || !key) throw new Error('Set the web app URL and your key in Settings first.');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ key, action: 'export_events' })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'export failed');
  return data.events || [];
}

export function startBackgroundSync() {
  syncNow();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') syncNow();
  });
  window.addEventListener('focus', () => syncNow());
  setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
  }, 60000);
}
