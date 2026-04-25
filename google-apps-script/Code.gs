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

/**
 * Web-app endpoint for the dashboard.
 *
 * Deploy: Apps Script editor > Deploy > New deployment
 *   Type: Web app
 *   Execute as: Me
 *   Who has access: Anyone with the link
 *
 * Auth: caller must pass ?token=<WEBHOOK_SECRET> matching the Script Property.
 * Returns JSON: { stats, daily, entries }.
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

  var lastRow = sheet.getLastRow();
  var stats   = { total: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
  var entries = [];
  var byDay   = {};

  if (lastRow >= 2) {
    var n          = lastRow - 1;
    var firstNames = sheet.getRange(2, FIRST_NAME_COL, n, 1).getValues();
    var phones     = sheet.getRange(2, PHONE_COL,      n, 1).getValues();
    var statuses   = sheet.getRange(2, WA_STATUS_COL,  n, 1).getValues();
    var times      = sheet.getRange(2, WA_TIME_COL,    n, 1).getValues();

    for (var i = 0; i < n; i++) {
      var phone  = String(phones[i][0] || '').trim();
      var name   = String(firstNames[i][0] || '').trim();
      var status = String(statuses[i][0] || '').trim();
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
        row: i + 2,
        name: name,
        phone: phone,
        status: category,
        detail: detail,
        time: time
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
