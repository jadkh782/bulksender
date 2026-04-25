/**
 * Google Apps Script for automatic WhatsApp sending on new form submissions.
 *
 * Install this in your Google Sheet via Extensions > Apps Script.
 *
 * Required Script Properties (Project Settings > Script Properties):
 *   WEBHOOK_URL    – e.g. https://your-app.vercel.app/api/auto-send
 *   WEBHOOK_SECRET – same secret stored in Vercel env vars
 *
 * Sheet column mapping (0-indexed for e.values):
 *   Index 0 (Col A): First name
 *   Index 3 (Col D): Phone number
 */

// Column indices in the "new LEADS" sheet (1-based, for Range operations)
var FIRST_NAME_COL = 1;  // Column A
var PHONE_COL      = 4;  // Column D
var WA_STATUS_COL  = 36; // Column AJ – WhatsApp send status (after all existing data)
var WA_TIME_COL    = 37; // Column AK – WhatsApp send timestamp

/**
 * Trigger handler – called automatically on each new Google Form submission.
 * Reads the submitted row and sends a WhatsApp message via the Vercel webhook.
 */
function onFormSubmit(e) {
  if (!e || !e.range) return;

  var sheet = e.range.getSheet();
  var row = e.range.getRow();

  var firstName = String(sheet.getRange(row, FIRST_NAME_COL).getValue()).trim();
  var phone     = String(sheet.getRange(row, PHONE_COL).getValue()).trim();

  if (!phone) {
    sheet.getRange(row, WA_STATUS_COL).setValue('WA_SKIPPED: no phone');
    sheet.getRange(row, WA_TIME_COL).setValue(new Date().toISOString());
    return;
  }

  var props   = PropertiesService.getScriptProperties();
  var url     = props.getProperty('WEBHOOK_URL');
  var secret  = props.getProperty('WEBHOOK_SECRET');

  if (!url || !secret) {
    sheet.getRange(row, WA_STATUS_COL).setValue('WA_FAILED: missing script properties');
    sheet.getRange(row, WA_TIME_COL).setValue(new Date().toISOString());
    return;
  }

  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + secret },
      payload: JSON.stringify({ phone: phone, name: firstName }),
      muteHttpExceptions: true
    });

    var httpCode = response.getResponseCode();
    var result   = JSON.parse(response.getContentText());

    if (httpCode === 200 && result.success) {
      sheet.getRange(row, WA_STATUS_COL).setValue('WA_SENT: ' + (result.messageId || 'ok'));
    } else {
      sheet.getRange(row, WA_STATUS_COL).setValue('WA_FAILED: ' + (result.error || 'HTTP ' + httpCode));
    }
  } catch (err) {
    sheet.getRange(row, WA_STATUS_COL).setValue('WA_FAILED: ' + err.message);
  }

  sheet.getRange(row, WA_TIME_COL).setValue(new Date().toISOString());
}

/**
 * Manual function to process any rows that have a phone but no WA status.
 * Useful for retrying failed sends (clear the WA status cell first).
 * Run from the Apps Script editor: select manualProcessPending > Run.
 */
function manualProcessPending() {
  var sheet   = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('new LEADS');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var props  = PropertiesService.getScriptProperties();
  var url    = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');

  if (!url || !secret) {
    Logger.log('Missing WEBHOOK_URL or WEBHOOK_SECRET in Script Properties');
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another execution is running');
    return;
  }

  var processed = 0;

  try {
    for (var row = 2; row <= lastRow; row++) {
      var phone    = String(sheet.getRange(row, PHONE_COL).getValue()).trim();
      var waStatus = String(sheet.getRange(row, WA_STATUS_COL).getValue()).trim();

      // Skip if no phone or already processed
      if (!phone || waStatus !== '') continue;

      var firstName = String(sheet.getRange(row, FIRST_NAME_COL).getValue()).trim();

      try {
        var response = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'Authorization': 'Bearer ' + secret },
          payload: JSON.stringify({ phone: phone, name: firstName }),
          muteHttpExceptions: true
        });

        var httpCode = response.getResponseCode();
        var result   = JSON.parse(response.getContentText());

        if (httpCode === 200 && result.success) {
          sheet.getRange(row, WA_STATUS_COL).setValue('WA_SENT: ' + (result.messageId || 'ok'));
        } else {
          sheet.getRange(row, WA_STATUS_COL).setValue('WA_FAILED: ' + (result.error || 'HTTP ' + httpCode));
        }
      } catch (err) {
        sheet.getRange(row, WA_STATUS_COL).setValue('WA_FAILED: ' + err.message);
      }

      sheet.getRange(row, WA_TIME_COL).setValue(new Date().toISOString());
      processed++;

      Utilities.sleep(300); // rate limiting
    }
  } finally {
    lock.releaseLock();
  }

  Logger.log('Processed ' + processed + ' rows');
}

// Column G holds the lead's category/group; surfaced in the dashboard for filtering.
var GROUP_COL = 7;

/**
 * Web-app endpoint for the dashboard.
 *
 * Deploy: Apps Script editor > Deploy > New deployment
 *   Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone
 *
 * Auth:    caller must pass ?token=<WEBHOOK_SECRET> matching the Script Property.
 * Params:  ?fromRow=<n>  (optional, default 2) — skip rows before <n>
 * Returns: { stats, daily, entries: [{ row, name, phone, group, status, detail, time }] }
 */
function doGet(e) {
  var props  = PropertiesService.getScriptProperties();
  var secret = props.getProperty('WEBHOOK_SECRET');
  var token  = (e && e.parameter && e.parameter.token) || '';

  if (!secret || token !== secret) {
    return _json({ error: 'Unauthorized' });
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('new LEADS');
  if (!sheet) return _json({ error: 'Sheet "new LEADS" not found' });

  var fromRow = parseInt((e && e.parameter && e.parameter.fromRow) || '2', 10);
  if (isNaN(fromRow) || fromRow < 2) fromRow = 2;

  var lastRow = sheet.getLastRow();
  var stats   = { total: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
  var entries = [];
  var byDay   = {};

  if (lastRow >= fromRow) {
    var n          = lastRow - fromRow + 1;
    var firstNames = sheet.getRange(fromRow, FIRST_NAME_COL, n, 1).getValues();
    var phones     = sheet.getRange(fromRow, PHONE_COL,      n, 1).getValues();
    var groups     = sheet.getRange(fromRow, GROUP_COL,      n, 1).getValues();
    var statuses   = sheet.getRange(fromRow, WA_STATUS_COL,  n, 1).getValues();
    var times      = sheet.getRange(fromRow, WA_TIME_COL,    n, 1).getValues();

    for (var i = 0; i < n; i++) {
      var phone  = String(phones[i][0]     || '').trim();
      var name   = String(firstNames[i][0] || '').trim();
      var group  = String(groups[i][0]     || '').trim();
      var status = String(statuses[i][0]   || '').trim();
      var time   = times[i][0] ? String(times[i][0]).trim() : '';

      if (!phone && !status && !name) continue;

      stats.total++;

      var category = 'pending';
      var detail   = '';
      if (status.indexOf('WA_SENT') === 0) {
        category = 'sent';
        stats.sent++;
        detail = status.replace(/^WA_SENT:\s*/, '');
      } else if (status.indexOf('WA_FAILED') === 0) {
        category = 'failed';
        stats.failed++;
        detail = status.replace(/^WA_FAILED:\s*/, '');
      } else if (status.indexOf('WA_SKIPPED') === 0) {
        category = 'skipped';
        stats.skipped++;
        detail = status.replace(/^WA_SKIPPED:\s*/, '');
      } else {
        stats.pending++;
      }

      if (time && (category === 'sent' || category === 'failed')) {
        var day = time.substring(0, 10);
        if (!byDay[day]) byDay[day] = { sent: 0, failed: 0 };
        byDay[day][category]++;
      }

      entries.push({
        row:    fromRow + i,
        name:   name,
        phone:  phone,
        group:  group,
        status: category,
        detail: detail,
        time:   time
      });
    }
  }

  entries.sort(function(a, b) {
    if (!a.time && !b.time) return b.row - a.row;
    if (!a.time) return 1;
    if (!b.time) return -1;
    return b.time < a.time ? -1 : (b.time > a.time ? 1 : 0);
  });

  var daily = [];
  var today = new Date();
  for (var d = 13; d >= 0; d--) {
    var t   = new Date(today.getTime() - d * 86400000);
    var key = t.toISOString().substring(0, 10);
    daily.push({
      day: key,
      sent: byDay[key] ? byDay[key].sent : 0,
      failed: byDay[key] ? byDay[key].failed : 0
    });
  }

  return _json({
    stats: stats,
    daily: daily,
    entries: entries.slice(0, 200),
    generatedAt: new Date().toISOString()
  });
}

/**
 * Web-app POST endpoint — triggers a 360dialog send for a list of pending rows.
 * Body: { action: "send", rows: [<absolute sheet row>, ...] }
 * Hard-capped at 50 rows per call so we stay under Apps Script's execution limit.
 */
var SEND_BATCH_CAP = 50;

function doPost(e) {
  var props  = PropertiesService.getScriptProperties();
  var secret = props.getProperty('WEBHOOK_SECRET');
  var url    = props.getProperty('WEBHOOK_URL');
  var token  = (e && e.parameter && e.parameter.token) || '';

  if (!secret || token !== secret) return _json({ error: 'Unauthorized' });
  if (!url)                        return _json({ error: 'WEBHOOK_URL missing in Script Properties' });

  var body;
  try {
    body = JSON.parse((e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return _json({ error: 'Invalid JSON body' });
  }

  if (body.action !== 'send' || !Array.isArray(body.rows) || body.rows.length === 0) {
    return _json({ error: 'Expected { action: "send", rows: [number, ...] }' });
  }

  var rows = body.rows.slice(0, SEND_BATCH_CAP).map(function(r) { return parseInt(r, 10); })
                      .filter(function(r) { return !isNaN(r) && r >= 2; });
  if (rows.length === 0) return _json({ error: 'No valid rows' });

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('new LEADS');
  if (!sheet) return _json({ error: 'Sheet "new LEADS" not found' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return _json({ error: 'Another send is already running' });

  var results = [];

  try {
    for (var i = 0; i < rows.length; i++) {
      results.push(_sendRow(sheet, rows[i], url, secret));
      if (i < rows.length - 1) Utilities.sleep(300);
    }
  } finally {
    lock.releaseLock();
  }

  return _json({ results: results });
}

// Sends one row through WEBHOOK_URL and writes the outcome back to the sheet.
// Returns { row, status: 'sent'|'failed'|'skipped', detail }.
function _sendRow(sheet, row, url, secret) {
  var phone     = String(sheet.getRange(row, PHONE_COL).getValue()).trim();
  var firstName = String(sheet.getRange(row, FIRST_NAME_COL).getValue()).trim();
  var now       = new Date().toISOString();

  if (!phone) {
    sheet.getRange(row, WA_STATUS_COL).setValue('WA_SKIPPED: no phone');
    sheet.getRange(row, WA_TIME_COL).setValue(now);
    return { row: row, status: 'skipped', detail: 'no phone' };
  }

  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + secret },
      payload: JSON.stringify({ phone: phone, name: firstName }),
      muteHttpExceptions: true
    });

    var httpCode = response.getResponseCode();
    var result   = JSON.parse(response.getContentText());

    if (httpCode === 200 && result.success) {
      var id = result.messageId || 'ok';
      sheet.getRange(row, WA_STATUS_COL).setValue('WA_SENT: ' + id);
      sheet.getRange(row, WA_TIME_COL).setValue(now);
      return { row: row, status: 'sent', detail: id };
    }

    var err = result.error || ('HTTP ' + httpCode);
    sheet.getRange(row, WA_STATUS_COL).setValue('WA_FAILED: ' + err);
    sheet.getRange(row, WA_TIME_COL).setValue(now);
    return { row: row, status: 'failed', detail: err };
  } catch (err) {
    sheet.getRange(row, WA_STATUS_COL).setValue('WA_FAILED: ' + err.message);
    sheet.getRange(row, WA_TIME_COL).setValue(now);
    return { row: row, status: 'failed', detail: err.message };
  }
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * One-time setup: installs the onFormSubmit trigger.
 * Run this once from the Apps Script editor: select setupTrigger > Run.
 * You will be prompted to authorize the script.
 */
function setupTrigger() {
  // Remove any existing onFormSubmit triggers to avoid duplicates
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'onFormSubmit') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  ScriptApp.newTrigger('onFormSubmit')
    .forSpreadsheet(SpreadsheetApp.getActive())
    .onFormSubmit()
    .create();

  Logger.log('onFormSubmit trigger installed successfully');
}
