// Talks to the Apps Script backend. One action, "sync": send whatever
// changed locally, get back the merged full state.

import {
  getConn, getTasks, replaceAllTasks, getSettings, replaceSettings,
  getDirtyTaskIds, clearDirtyTasks, markTaskDirty, isSettingsDirty, clearSettingsDirty,
  getEventQueue, clearEventQueue, backfillFieldUpdatedAt, CORE_FIELDS
} from './store.js?v=2026-10-09.1';

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

// Merges one incoming (server) task against whatever is CURRENTLY in local
// storage for that id, field by field, keeping whichever side has the newer
// fieldUpdatedAt for each field. Needed because a sync round trip takes
// real time (a fetch, server-side processing): she can complete a task, or
// edit anything else, in the window between this request going out and its
// response coming back. Without this, a plain full overwrite of local
// storage with the server's answer would silently revert whatever changed
// locally during that window, since the server's response reflects state
// from before that local edit ever happened. This is the client-side
// mirror of the same per-field merge Code.gs already does server-side for
// two different DEVICES (see SPEC.md's Sync protocol); this closes the same
// hole for two edits on the SAME device racing a single sync's round trip.
function mergeIncoming_(incoming, current) {
  if (!current) return incoming;
  const fieldUpdatedAt = Object.assign({}, incoming.fieldUpdatedAt);
  const merged = Object.assign({}, incoming);
  for (const f of CORE_FIELDS) {
    const incomingTs = incoming.fieldUpdatedAt && incoming.fieldUpdatedAt[f];
    const currentTs = current.fieldUpdatedAt && current.fieldUpdatedAt[f];
    if (currentTs && (!incomingTs || currentTs > incomingTs)) {
      merged[f] = current[f];
      fieldUpdatedAt[f] = currentTs;
    }
  }
  merged.fieldUpdatedAt = fieldUpdatedAt;
  merged.updatedAt = current.updatedAt > incoming.updatedAt ? current.updatedAt : incoming.updatedAt;
  return merged;
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
  // Snapshot each dirty task's updatedAt now, before the request goes out.
  // The dirty flag only gets cleared below for a task whose updatedAt still
  // matches this snapshot once the response comes back: one edited again
  // while this request was in flight has since moved on to a newer
  // updatedAt, so it stays dirty and goes out on the next sync instead of
  // silently never reaching the server at all.
  const dirtySnapshotUpdatedAt = {};
  dirtyIds.forEach((id) => { if (tasksById[id]) dirtySnapshotUpdatedAt[id] = tasksById[id].updatedAt; });
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

    // Re-read local storage fresh now that the round trip is done, not the
    // `tasksById` snapshot from before the request went out: anything done
    // locally while this was in flight (completing a task, starting one,
    // adding a new one) lives here and nowhere else yet, and the server's
    // response above knows nothing about any of it.
    const currentTasksById = getTasks();
    const merged = incomingTasks.map((t) => mergeIncoming_(t, currentTasksById[t.id]));
    const incomingIds = new Set(merged.map((t) => t.id));
    // A task created locally after this request's payload was already sent
    // won't be in the server's response at all (the server has never heard
    // of it yet); keep it, rather than letting a blind overwrite silently
    // delete it, the same race as above but for a brand new task instead of
    // an edit to an existing one.
    const localOnly = Object.values(currentTasksById).filter((t) => !incomingIds.has(t.id));
    const finalTasks = merged.concat(localOnly);

    // Did this pull actually change anything the screen could be showing?
    // A background sync (periodic, or on focus) used to silently replace
    // the local data with no way for main.js to know it should refresh,
    // meaning the screen could go stale relative to reality: tapping
    // "Done" on a task that's already been removed or changed underneath
    // it would find nothing to update and do nothing, silently. Comparing
    // a cheap fingerprint lets the caller re-render only when something
    // genuinely changed, not on every empty 60-second poll.
    const before = fingerprint_(Object.values(tasksById));
    const after = fingerprint_(finalTasks);

    replaceAllTasks(finalTasks);
    if (data.settings) replaceSettings(data.settings);
    const stillCurrentDirtyIds = dirtyIds.filter((id) => {
      const nowTask = currentTasksById[id];
      return nowTask && nowTask.updatedAt === dirtySnapshotUpdatedAt[id];
    });
    clearDirtyTasks(stillCurrentDirtyIds);
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
