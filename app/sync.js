// Talks to the Apps Script backend. One action, "sync": send whatever
// changed locally, get back the merged full state.

import {
  getConn, getTasks, replaceAllTasks, getSettings, replaceSettings,
  getDirtyTaskIds, clearDirtyTasks, isSettingsDirty, clearSettingsDirty,
  getEventQueue, clearEventQueue
} from './store.js';

let pushTimer = null;
let syncing = false;
let listeners = [];

export function onSyncStatus(fn) {
  listeners.push(fn);
}
function announce_(status, detail) {
  for (const fn of listeners) fn(status, detail);
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

    replaceAllTasks(data.tasks || []);
    if (data.settings) replaceSettings(data.settings);
    clearDirtyTasks(dirtyIds);
    if (settingsDirty) clearSettingsDirty();
    clearEventQueue(events.map((e) => e.id));

    announce_('ok');
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
