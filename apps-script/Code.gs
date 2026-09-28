/**
 * Ducks backend: one Apps Script web app, no database, no login.
 * Data lives in Stephanie's Drive as JSON files in a "Ducks" folder.
 *
 * SETUP (see docs/setup.md for the full numbered walkthrough):
 * 1. Paste this whole file into a new Apps Script project.
 * 2. Project Settings > Script Properties, add:
 *      OWNER_KEY   = a long random string (Stephanie's device key)
 *      KID_ANGEL   = a different long random string
 *      KID_MAX     = a different long random string
 *      KID_BRIE    = a different long random string
 *    (For the Step 0 test, only OWNER_KEY and one KID_TEST key are needed.)
 * 3. Deploy > New deployment > Web app > Execute as: Me,
 *    Who has access: Anyone > Deploy. Copy the web app URL.
 *
 * This file currently implements only what Step 0 needs to prove the
 * approach: save/load a test message as the owner, and have a "kid" submit
 * something into a separate test inbox. Phase 1 will replace TEST_ actions
 * with the real task list, sync/merge, and event log.
 */

var FOLDER_NAME = 'Ducks';
var TEST_DATA_FILE = 'ducks-test-data.json';
var TEST_INBOX_FILE = 'ducks-test-inbox.json';

function doGet(e) {
  return textResponse_({ ok: true, message: 'Ducks test endpoint is alive.' });
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var key = body.key || '';
    var action = body.action || '';

    if (matchesOwnerKey_(key)) {
      return handleOwnerAction_(action, body);
    }

    var kidName = kidNameForKey_(key);
    if (kidName) {
      return handleKidAction_(action, body, kidName);
    }

    return textResponse_({ ok: false, error: 'Key not recognized.' });
  } catch (err) {
    return textResponse_({ ok: false, error: String(err) });
  }
}

function handleOwnerAction_(action, body) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (action === 'save_test') {
      writeJsonFile_(TEST_DATA_FILE, { message: body.message, savedAt: new Date().toISOString() });
      return textResponse_({ ok: true, saved: true });
    }
    if (action === 'load_test') {
      var data = readJsonFile_(TEST_DATA_FILE, { message: null, savedAt: null });
      return textResponse_({ ok: true, data: data });
    }
    if (action === 'check_kid_inbox') {
      var inbox = readJsonFile_(TEST_INBOX_FILE, { entries: [] });
      return textResponse_({ ok: true, inbox: inbox.entries });
    }
    return textResponse_({ ok: false, error: 'Unknown owner action: ' + action });
  } finally {
    lock.releaseLock();
  }
}

function handleKidAction_(action, body, kidName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (action === 'kid_submit') {
      var inbox = readJsonFile_(TEST_INBOX_FILE, { entries: [] });
      inbox.entries.push({
        name: kidName,
        message: body.message,
        neededBy: body.neededBy || null,
        submittedAt: new Date().toISOString()
      });
      writeJsonFile_(TEST_INBOX_FILE, inbox);
      return textResponse_({ ok: true, greeting: 'Quack! Mom got it, ' + kidName + '.' });
    }
    return textResponse_({ ok: false, error: 'Unknown kid action: ' + action });
  } finally {
    lock.releaseLock();
  }
}

function matchesOwnerKey_(key) {
  var owner = PropertiesService.getScriptProperties().getProperty('OWNER_KEY');
  return !!owner && key === owner;
}

function kidNameForKey_(key) {
  var props = PropertiesService.getScriptProperties().getProperties();
  for (var prop in props) {
    if (prop.indexOf('KID_') === 0 && props[prop] === key) {
      return prop.substring(4);
    }
  }
  return null;
}

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
