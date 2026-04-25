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

// Autonomous send-loop config.
// Time-trigger handler name + per-tick batch size. Allowed cadences in minutes:
// 1, 5, 10, 15, 30, 60. Anything else is rejected by installAutoSendTrigger.
var AUTO_TICK_FN = 'autoSendTick';
var AUTO_BATCH   = 50;

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

// Extra columns surfaced in the dashboard for filtering.
var COL_E = 5;  // Column E
var COL_G = 7;  // Column G

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
 * Returns: { stats, daily, entries: [{ row, name, phone, colE, colG, status, detail, time }] }
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
    var colsE      = sheet.getRange(fromRow, COL_E,          n, 1).getValues();
    var colsG      = sheet.getRange(fromRow, COL_G,          n, 1).getValues();
    var statuses   = sheet.getRange(fromRow, WA_STATUS_COL,  n, 1).getValues();
    var times      = sheet.getRange(fromRow, WA_TIME_COL,    n, 1).getValues();

    for (var i = 0; i < n; i++) {
      var phone  = String(phones[i][0]     || '').trim();
      var name   = String(firstNames[i][0] || '').trim();
      var colE   = String(colsE[i][0]      || '').trim();
      var colG   = String(colsG[i][0]      || '').trim();
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
        detail = status.replace(/^WA_FAILED2?:\s*/, '');
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
        colE:   colE,
        colG:   colG,
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
    entries: entries,
    autoSend: _autoSendStatus(props),
    generatedAt: new Date().toISOString()
  });
}

// Read-only snapshot of the auto-send config from Script Properties.
function _autoSendStatus(props) {
  return {
    enabled:     props.getProperty('AUTO_SEND_ENABLED') === '1',
    intervalMin: parseInt(props.getProperty('AUTO_SEND_INTERVAL_MIN') || '0', 10) || 0,
    retryOnce:   props.getProperty('AUTO_SEND_RETRY') === '1',
    lastTick:    props.getProperty('AUTO_SEND_LAST_TICK') || ''
  };
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

  if (body.action === 'configureAuto') {
    return _handleConfigureAuto(body, props);
  }

  if (body.action !== 'send' || !Array.isArray(body.rows) || body.rows.length === 0) {
    return _json({ error: 'Expected { action: "send", rows: [number, ...] } or { action: "configureAuto", ... }' });
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
    var raw      = response.getContentText() || '';
    var result   = {};
    try { result = JSON.parse(raw); } catch (parseErr) { /* leave empty; raw used below */ }

    if (httpCode === 200 && result.success) {
      var id = result.messageId || 'ok';
      sheet.getRange(row, WA_STATUS_COL).setValue('WA_SENT: ' + id);
      sheet.getRange(row, WA_TIME_COL).setValue(now);
      return { row: row, status: 'sent', detail: id };
    }

    var err = result.error
            || ('HTTP ' + httpCode + (raw ? ' — ' + raw.substring(0, 120) : ' — empty body'));
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

// ─────────────────────────────────────────────────────────────────
// Autonomous send loop
// ─────────────────────────────────────────────────────────────────

var ALLOWED_INTERVALS = [1, 5, 10, 15, 30, 60];

// doPost handler for { action: "configureAuto", enabled, intervalMin, retryOnce }.
// Persists the config and (re)installs / removes the time trigger.
function _handleConfigureAuto(body, props) {
  var enabled    = body.enabled === true || body.enabled === '1' || body.enabled === 1;
  var intervalMin = parseInt(body.intervalMin, 10) || 0;
  var retryOnce  = body.retryOnce === true || body.retryOnce === '1' || body.retryOnce === 1;

  if (enabled && ALLOWED_INTERVALS.indexOf(intervalMin) === -1) {
    return _json({ error: 'intervalMin must be one of ' + ALLOWED_INTERVALS.join(', ') });
  }

  props.setProperty('AUTO_SEND_ENABLED',      enabled ? '1' : '0');
  props.setProperty('AUTO_SEND_INTERVAL_MIN', enabled ? String(intervalMin) : '0');
  props.setProperty('AUTO_SEND_RETRY',        retryOnce ? '1' : '0');

  installAutoSendTrigger(enabled ? intervalMin : 0);

  return _json({ ok: true, autoSend: _autoSendStatus(props) });
}

// Removes any existing autoSendTick triggers; if intervalMin > 0, installs a new one.
function installAutoSendTrigger(intervalMin) {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === AUTO_TICK_FN) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  if (!intervalMin) return;
  if (ALLOWED_INTERVALS.indexOf(intervalMin) === -1) {
    throw new Error('Unsupported intervalMin: ' + intervalMin);
  }
  var b = ScriptApp.newTrigger(AUTO_TICK_FN).timeBased();
  if (intervalMin === 60) b.everyHours(1).create();
  else                    b.everyMinutes(intervalMin).create();
}

// Time-trigger handler. Drains up to AUTO_BATCH eligible rows per call.
// Eligibility: phone present AND (status empty OR (retryOnce && status starts with
// 'WA_FAILED:' but NOT 'WA_FAILED2:')). Failed retries become WA_FAILED2.
function autoSendTick() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('AUTO_SEND_ENABLED') !== '1') return;

  var url    = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');
  if (!url || !secret) {
    Logger.log('autoSendTick: missing WEBHOOK_URL or WEBHOOK_SECRET');
    return;
  }
  var retryOnce = props.getProperty('AUTO_SEND_RETRY') === '1';

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('new LEADS');
  if (!sheet) { Logger.log('autoSendTick: sheet not found'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('autoSendTick: lock busy'); return; }

  try {
    // Pull phone (D) and status (AJ) for the whole sheet in two batched reads.
    var n        = lastRow - 1;
    var phones   = sheet.getRange(2, PHONE_COL,     n, 1).getValues();
    var statuses = sheet.getRange(2, WA_STATUS_COL, n, 1).getValues();

    var picks = [];   // { row, isRetry }
    for (var i = 0; i < n && picks.length < AUTO_BATCH; i++) {
      var phone  = String(phones[i][0]   || '').trim();
      var status = String(statuses[i][0] || '').trim();
      if (!phone) continue;

      if (status === '') {
        picks.push({ row: i + 2, isRetry: false });
      } else if (retryOnce && status.indexOf('WA_FAILED:') === 0 && status.indexOf('WA_FAILED2:') !== 0) {
        picks.push({ row: i + 2, isRetry: true });
      }
    }

    var sent = 0, failed = 0, skipped = 0;
    for (var p = 0; p < picks.length; p++) {
      var r = _sendRowAuto(sheet, picks[p].row, url, secret, picks[p].isRetry);
      if      (r.status === 'sent')    sent++;
      else if (r.status === 'failed')  failed++;
      else if (r.status === 'skipped') skipped++;
      if (p < picks.length - 1) Utilities.sleep(300);
    }

    props.setProperty('AUTO_SEND_LAST_TICK', new Date().toISOString());
    Logger.log('autoSendTick: ' + picks.length + ' picked · ' +
               sent + ' sent · ' + failed + ' failed · ' + skipped + ' skipped');
  } finally {
    lock.releaseLock();
  }
}

// Wraps _sendRow. If this attempt is itself a retry (the row was already
// WA_FAILED) and it fails again, swap WA_FAILED: -> WA_FAILED2: in the sheet
// so the auto loop won't pick it up next tick.
function _sendRowAuto(sheet, row, url, secret, isRetry) {
  var r = _sendRow(sheet, row, url, secret);
  if (isRetry && r.status === 'failed') {
    var current = String(sheet.getRange(row, WA_STATUS_COL).getValue());
    if (current.indexOf('WA_FAILED:') === 0) {
      sheet.getRange(row, WA_STATUS_COL).setValue('WA_FAILED2:' + current.substring('WA_FAILED:'.length));
    }
  }
  return r;
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
