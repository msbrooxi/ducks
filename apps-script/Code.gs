/**
 * Ducks backend: one Apps Script web app, no database, no login.
 * All data lives in Stephanie's Drive as JSON files in a "Ducks" folder.
 * See docs/setup.md for how to deploy this and docs/SPEC.md for the full
 * data model and merge rules this file implements.
 *
 * Script Properties needed (Project Settings > Script Properties):
 *   OWNER_KEY   = Stephanie's long random device key
 *   KID_ANGEL   = Angelina's long random key
 *   KID_MAX     = Max's long random key
 *   KID_BRIE    = Gabriella's long random key
 *
 * The web app takes one POST action, "sync", for everything the owner's
 * devices do (push local changes, pull the merged result), and one action,
 * "kid_submit", for the kid pages (create-only, never returns task data).
 */

var FOLDER_NAME = 'Ducks';
var DATA_FILE = 'ducks-data.json';
var EVENTS_FILE = 'ducks-events.json';
var MAX_EVENTS_RETURNED = 500;

// Keep this in sync with app/store.js's CORE_FIELDS.
var CORE_FIELDS = [
  'title', 'notes', 'link', 'ducks', 'due', 'size', 'category',
  'status', 'doingSince', 'completedAt', 'deletedAt',
  'recurrence', 'projectId', 'order', 'chip', 'dependsOn'
];

var DEFAULT_SETTINGS = {
  rankSlider: 50,
  dueSoonDays: 3,
  quickWinSizes: ['S'],
  sizeMinutes: { S: 15, M: 30, L: 60 },
  duckFillWeights: { S: 0.25, M: 0.5, L: 0.75, XL: 1 },
  dayStartHour: 3,
  updatedAt: '1970-01-01T00:00:00.000Z'
};

function doGet(e) {
  return textResponse_({ ok: true, message: 'Ducks backend is alive.' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var key = body.key || '';
    var action = body.action || '';

    if (matchesOwnerKey_(key)) {
      if (action === 'sync') return withLock_(function () { return handleSync_(body); });
      if (action === 'export_events') return withLock_(function () { return handleExportEvents_(); });
      return textResponse_({ ok: false, error: 'Unknown owner action: ' + action });
    }

    var kidName = kidNameForKey_(key);
    if (kidName) {
      if (action === 'kid_submit') return withLock_(function () { return handleKidSubmit_(body, kidName); });
      return textResponse_({ ok: false, error: 'Unknown kid action: ' + action });
    }

    return textResponse_({ ok: false, error: 'Key not recognized.' });
  } catch (err) {
    return textResponse_({ ok: false, error: String(err) });
  }
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---- owner: sync (push local changes, get back the merged full state) ----

function handleSync_(body) {
  var store = readJsonFile_(DATA_FILE, { tasks: {}, settings: DEFAULT_SETTINGS });
  if (!store.settings) store.settings = DEFAULT_SETTINGS;
  if (!store.tasks) store.tasks = {};

  var incomingTasks = body.tasks || [];
  for (var i = 0; i < incomingTasks.length; i++) {
    mergeTask_(store.tasks, incomingTasks[i]);
  }

  // Assign the human-friendly #1, #2, #3... reference number here, on the
  // server, to any task that doesn't have one yet. Doing it here (not on
  // the device that creates the task) is what keeps two devices creating
  // tasks offline from ever handing out the same number: whichever one
  // reaches the server first gets the next number, the other gets the one
  // after. Runs on every sync, including a plain pull, so a task backfilled
  // by an old client (or restored some other way) still gets numbered.
  if (!store.nextSeq) store.nextSeq = 0;
  for (var taskId in store.tasks) {
    var existingTask = store.tasks[taskId];
    if (existingTask.seq == null) {
      store.nextSeq += 1;
      existingTask.seq = store.nextSeq;
    }
  }

  var incomingSettings = body.settings;
  if (incomingSettings && (!store.settings.updatedAt || incomingSettings.updatedAt > store.settings.updatedAt)) {
    store.settings = incomingSettings;
  }

  writeJsonFile_(DATA_FILE, store);

  var incomingEvents = body.events || [];
  if (incomingEvents.length > 0) appendEvents_(incomingEvents);

  return textResponse_({
    ok: true,
    tasks: valuesOf_(store.tasks),
    settings: store.settings
  });
}

// A task is missing a per-field timestamp for a field either because it
// predates per-field merge entirely (no fieldUpdatedAt object at all) or
// because it was touched before some specific field was added to
// CORE_FIELDS. Either way, stamp every missing field with the task's own
// updatedAt/createdAt rather than leaving it undefined, mirroring the
// client's own backfillFieldUpdatedAt in store.js. Mutates and returns the
// same task object.
function ensureFieldUpdatedAt_(task) {
  var ts = task.updatedAt || task.createdAt || new Date().toISOString();
  var fu = task.fieldUpdatedAt || {};
  for (var i = 0; i < CORE_FIELDS.length; i++) {
    var f = CORE_FIELDS[i];
    if (!fu[f]) fu[f] = ts;
  }
  task.fieldUpdatedAt = fu;
  return task;
}

// Per-field merge (added 2026-09-29, revised 2026-10-02). The original
// version replaced the entire task whenever incoming.updatedAt was newer,
// which meant: rate ducks on the phone, then edit the category on the
// laptop before the laptop had pulled that rating, and the laptop's stale
// copy of "ducks" would overwrite the phone's newer rating even though the
// laptop never touched that field. Per-field timestamps fixed most of that,
// but kept a dangerous escape hatch: whenever EITHER side's fieldUpdatedAt
// was missing entirely (any task that predates 2026-09-29 and hasn't had
// every field touched since), it fell back to comparing whole-task
// updatedAt and replacing the ENTIRE record. That's the same bug back from
// the dead for exactly those older tasks: complete a task on the phone,
// then make any unrelated edit on a laptop that still has a stale
// pre-completion copy of that same old task (because the laptop hadn't
// pulled the completion yet), and the laptop's newer updatedAt would blow
// away the phone's completion, status and all, the moment it synced. This
// is the most likely explanation for completed tasks reappearing as open
// and past due days later. Fixed by never leaving fieldUpdatedAt missing:
// both sides get backfilled before merging, so the per-field comparison
// below is always what actually runs, with no whole-record fallback.
function mergeTask_(tasksById, incoming) {
  if (!incoming || !incoming.id) return;
  ensureFieldUpdatedAt_(incoming);
  var existing = tasksById[incoming.id];
  if (!existing) {
    tasksById[incoming.id] = incoming;
    return;
  }
  ensureFieldUpdatedAt_(existing);

  var incomingFU = incoming.fieldUpdatedAt;
  var existingFU = existing.fieldUpdatedAt;

  var merged = Object.assign({}, existing);
  var mergedFU = Object.assign({}, existingFU);
  for (var field in incoming) {
    if (field === 'id' || field === 'fieldUpdatedAt') continue;
    var incomingTs = incomingFU[field];
    var existingTs = existingFU[field];
    if (incomingTs && (!existingTs || incomingTs > existingTs)) {
      merged[field] = incoming[field];
      mergedFU[field] = incomingTs;
    }
  }
  merged.fieldUpdatedAt = mergedFU;
  merged.updatedAt = incoming.updatedAt > existing.updatedAt ? incoming.updatedAt : existing.updatedAt;
  tasksById[incoming.id] = merged;
}

function valuesOf_(obj) {
  var out = [];
  for (var k in obj) out.push(obj[k]);
  return out;
}

// ---- owner: full event log export ----

function handleExportEvents_() {
  var log = readJsonFile_(EVENTS_FILE, { events: [] });
  return textResponse_({ ok: true, events: log.events });
}

function appendEvents_(newEvents) {
  var log = readJsonFile_(EVENTS_FILE, { events: [] });
  var seen = {};
  for (var i = 0; i < log.events.length; i++) seen[log.events[i].id] = true;
  for (var j = 0; j < newEvents.length; j++) {
    var ev = newEvents[j];
    if (ev && ev.id && !seen[ev.id]) {
      log.events.push(ev);
      seen[ev.id] = true;
    }
  }
  writeJsonFile_(EVENTS_FILE, log);
}

// ---- kid: create-only submission into the owner's inbox ----

function handleKidSubmit_(body, kidName) {
  var store = readJsonFile_(DATA_FILE, { tasks: {}, settings: DEFAULT_SETTINGS });
  if (!store.tasks) store.tasks = {};

  var now = new Date().toISOString();
  var id = Utilities.getUuid();
  var slug = kidName.toLowerCase();

  var fieldUpdatedAt = {};
  for (var i = 0; i < CORE_FIELDS.length; i++) fieldUpdatedAt[CORE_FIELDS[i]] = now;

  var task = {
    id: id,
    title: body.message || '(no message)',
    notes: null,
    link: null,
    ducks: null,
    due: body.neededBy || null,
    size: null,
    category: 'admin',
    status: 'inbox',
    doingSince: null,
    source: slug,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    deletedAt: null,
    recurrence: null,
    projectId: null,
    order: null,
    chip: null,
    dependsOn: [],
    seq: null,
    fieldUpdatedAt: fieldUpdatedAt
  };
  store.tasks[id] = task;
  writeJsonFile_(DATA_FILE, store);

  appendEvents_([{
    id: Utilities.getUuid(),
    ts: now,
    taskId: id,
    type: 'kid_submitted',
    device: slug
  }]);

  return textResponse_({ ok: true, greeting: 'Quack! Mom got it, ' + kidName + '.' });
}

// ---- keys ----

function matchesOwnerKey_(key) {
  var owner = PropertiesService.getScriptProperties().getProperty('OWNER_KEY');
  return !!owner && !!key && key === owner;
}

function kidNameForKey_(key) {
  if (!key) return null;
  var props = PropertiesService.getScriptProperties().getProperties();
  for (var prop in props) {
    if (prop.indexOf('KID_') === 0 && props[prop] === key) {
      var raw = prop.substring(4).toLowerCase();
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    }
  }
  return null;
}

// ---- Drive file helpers ----

// getFoldersByName/getFilesByName don't promise their iteration order is
// stable across separate calls. If more than one folder or file ever ended
// up with the same name (easy to end up with by accident: re-running setup,
// a test deployment, Drive briefly double-listing something), two calls a
// moment apart could resolve to two DIFFERENT underlying file objects,
// which would look exactly like data randomly vanishing and reappearing.
// Picking the lowest file id breaks every tie the same way, every time, so
// every call resolves to the same object regardless of how many duplicates
// exist, until they're manually cleaned up.
function pickStable_(iterator) {
  var all = [];
  while (iterator.hasNext()) all.push(iterator.next());
  if (all.length === 0) return null;
  all.sort(function (a, b) { return a.getId() < b.getId() ? -1 : a.getId() > b.getId() ? 1 : 0; });
  return all[0];
}

function getFolder_() {
  var folder = pickStable_(DriveApp.getFoldersByName(FOLDER_NAME));
  if (folder) return folder;
  return DriveApp.createFolder(FOLDER_NAME);
}

function readJsonFile_(filename, fallback) {
  var folder = getFolder_();
  var file = pickStable_(folder.getFilesByName(filename));
  if (!file) return fallback; // genuinely doesn't exist yet, first run
  var content = file.getBlob().getDataAsString();
  if (!content) return fallback; // a brand new, never-written file
  try {
    return JSON.parse(content);
  } catch (e) {
    // The file exists and has content, but it didn't parse. Silently
    // falling back to an empty store here would make handleSync_ treat
    // this as "no tasks exist yet" and then WRITE BACK a store containing
    // only whatever this one request happens to be pushing, discarding
    // everything else ever saved. That is the most likely mechanism behind
    // "everything looked wiped, then came back a minute later": a
    // transient bad read got treated as real, emptied the file, and a
    // later request (possibly from a device with its own full local copy
    // still dirty) wrote the real data back. Failing loudly here instead
    // means a bad read just fails this one sync, client-side data is
    // untouched, and the next sync tries again rather than risking an
    // overwrite.
    throw new Error('Could not read ' + filename + ' (refusing to proceed rather than risk overwriting good data): ' + e);
  }
}

function writeJsonFile_(filename, obj) {
  var folder = getFolder_();
  var file = pickStable_(folder.getFilesByName(filename));
  var json = JSON.stringify(obj);
  if (file) {
    file.setContent(json);
  } else {
    folder.createFile(filename, json, MimeType.PLAIN_TEXT);
  }
}

function textResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
