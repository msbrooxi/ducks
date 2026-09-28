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

function mergeTask_(tasksById, incoming) {
  if (!incoming || !incoming.id) return;
  var existing = tasksById[incoming.id];
  if (!existing || !existing.updatedAt || incoming.updatedAt > existing.updatedAt) {
    tasksById[incoming.id] = incoming;
  }
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
    deletedAt: null
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

function getFolder_() {
  var folders = DriveApp.getFoldersByName(FOLDER_NAME);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(FOLDER_NAME);
}

function readJsonFile_(filename, fallback) {
  var folder = getFolder_();
  var files = folder.getFilesByName(filename);
  if (!files.hasNext()) return fallback;
  var content = files.next().getBlob().getDataAsString();
  try {
    return JSON.parse(content);
  } catch (e) {
    return fallback;
  }
}

function writeJsonFile_(filename, obj) {
  var folder = getFolder_();
  var files = folder.getFilesByName(filename);
  var json = JSON.stringify(obj);
  if (files.hasNext()) {
    files.next().setContent(json);
  } else {
    folder.createFile(filename, json, MimeType.PLAIN_TEXT);
  }
}

function textResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
