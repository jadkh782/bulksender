/**
 * Google Apps Script for automatic WhatsApp sending on new form submissions.
 *
 * Install this in your Google Sheet via Extensions > Apps Script.
 *
 * Required Script Properties (Project Settings > Script Properties):
 *   WEBHOOK_URL    – e.g. https://bulksender.<subdomain>.workers.dev/api/auto-send
 *   WEBHOOK_SECRET – same value set with `wrangler secret put WEBHOOK_SECRET`
 *
 * Sheet: "Mentoring-arabic"  (layout as of Sept 2026)
 *   Col A: First name
 *   Col B: Last name
 *   Col C: Email
 *   Col D: Phone number (WhatsApp)
 *   Col E: Professional situation
 *   Col F: Business status
 *   Col G: Available capital
 *   Col H: Reason for contact
 *   Col I: Best time to call
 *   Col J-N: utm_medium, utm_source, utm_campaign, utm_content, utm_term
 *   Col O: Submitted At        (was J before the utm_* columns were inserted)
 *   Col P: Token               (was K)
 *   Col R: Manual status ("statuis")   (was M)
 *   WhatsApp send status + timestamp: written by this script, located at
 *   runtime by their row-1 header labels rather than by a fixed position.
 *   See _waCols() for why.
 */

// Column indices in the "Mentoring-arabic" sheet (1-based, for Range operations).
// A and D sit left of every insert made so far, so they stay fixed.
var FIRST_NAME_COL = 1;  // Column A
var PHONE_COL      = 4;  // Column D

// Fallback positions for the two status columns, used only to place the header
// labels the first time. Everything else goes through _waStatusCol/_waTimeCol.
var WA_STATUS_COL  = 36; // Column AJ
var WA_TIME_COL    = 37; // Column AK

// Autonomous send-loop config.
// Time-trigger handler name + per-tick batch size. Allowed cadences in minutes:
// 1, 5, 10, 15, 30, 60. Anything else is rejected by installAutoSendTrigger.
var AUTO_TICK_FN = 'autoSendTick';
var AUTO_BATCH   = 50;

// HARD SAFETY FLOOR — rows BELOW this number are NEVER contacted by any
// send path (auto loop, dashboard manual send, form-submit trigger).
// This is enforced inside _sendRow itself, so even a buggy caller can't
// bypass it. Raising this requires editing Code.gs and redeploying —
// intentional, so no UI input or stale config can lower it.
var MIN_ROW_TO_SEND = 2;

// -----------------------------------------------------------------
// Locating the two status columns
// -----------------------------------------------------------------
//
// Sept 2026: five utm_* columns were inserted at J. Everything to their right
// shifted five places, so the status pair moved from AJ/AK to AO/AP. This
// script kept reading the old fixed positions, went blind to ~3,000 completed
// sends, and would have re-messaged every one of them on the next auto tick.
//
// The columns now carry a header label in row 1 and are found by that label at
// run time. Inserting a column moves the header along with its data, so the
// lookup follows it and the same break cannot happen again. WA_STATUS_COL and
// WA_TIME_COL survive only as the position where the labels get stamped the
// very first time.

var WA_STATUS_HEADER = 'WA Status';
var WA_TIME_HEADER   = 'WA Sent At';

var _waColsCache = null;

// { status: <1-based col>, time: <1-based col> }. Memoized: one read per run.
function _waCols(sheet) {
  if (_waColsCache) return _waColsCache;

  var maxCol  = sheet.getMaxColumns();
  var headers = sheet.getRange(1, 1, 1, maxCol).getValues()[0];
  var status  = 0;
  var time    = 0;

  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim();
    if      (h === WA_STATUS_HEADER && !status) status = i + 1;
    else if (h === WA_TIME_HEADER   && !time)   time   = i + 1;
  }

  if (!status || !time) {
    // Labels absent: first run since this change. Fall back to the historical
    // fixed positions and stamp the labels so every later run self-locates.
    status = status || WA_STATUS_COL;
    time   = time   || WA_TIME_COL;

    var need = Math.max(status, time);
    if (maxCol < need) sheet.insertColumnsAfter(maxCol, need - maxCol);

    sheet.getRange(1, status).setValue(WA_STATUS_HEADER);
    sheet.getRange(1, time).setValue(WA_TIME_HEADER);
    Logger.log('_waCols: labels were missing, stamped them at columns ' +
               status + ' and ' + time);
  }

  _waColsCache = { status: status, time: time };
  return _waColsCache;
}

function _waStatusCol(sheet) { return _waCols(sheet).status; }
function _waTimeCol(sheet)   { return _waCols(sheet).time; }


// -----------------------------------------------------------------
// Not messaging the same person twice
// -----------------------------------------------------------------
//
// 473 phone numbers in this sheet appear on more than one row, because people
// fill the form more than once. A per-row status therefore is not enough on its
// own: 143 rows in the pending queue belong to somebody who has already had the
// message. Every send path checks the number, not just the row.

// Same normalisation the Worker applies before dialling.
function _normPhone(p) {
  return String(p || '').replace(/[^0-9]/g, '');
}

var _sentPhonesCache = null;

// { <normalised phone>: <first row that got WA_SENT> }, memoized per run.
function _sentPhones(sheet) {
  if (_sentPhonesCache) return _sentPhonesCache;

  var map     = {};
  var lastRow = sheet.getLastRow();

  if (lastRow >= 2) {
    var n        = lastRow - 1;
    var phones   = sheet.getRange(2, PHONE_COL,          n, 1).getValues();
    var statuses = sheet.getRange(2, _waStatusCol(sheet), n, 1).getValues();

    for (var i = 0; i < n; i++) {
      if (String(statuses[i][0] || '').indexOf('WA_SENT') !== 0) continue;
      var phone = _normPhone(phones[i][0]);
      if (phone && !map[phone]) map[phone] = i + 2;
    }
  }

  _sentPhonesCache = map;
  return _sentPhonesCache;
}

/**
 * Trigger handler – called automatically on each new Google Form submission.
 * Reads the submitted row and sends a WhatsApp message via the Worker webhook.
 */
function onFormSubmit(e) {
  if (!e || !e.range) return;

  var sheet = e.range.getSheet();
  var row   = e.range.getRow();

  // Hard floor - refuse to contact anything below the send floor, even if
  // a form submission somehow lands there.
  if (row < MIN_ROW_TO_SEND) return;

  var props  = PropertiesService.getScriptProperties();
  var url    = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');

  if (!url || !secret) {
    sheet.getRange(row, _waStatusCol(sheet)).setValue('WA_FAILED: missing script properties');
    sheet.getRange(row, _waTimeCol(sheet)).setValue(new Date().toISOString());
    return;
  }

  _sendRow(sheet, row, url, secret);
}

/**
 * Manual function to process any rows that have a phone but no WA status.
 * Useful for retrying failed sends (clear the WA status cell first).
 * Run from the Apps Script editor: select manualProcessPending > Run.
 */
function manualProcessPending() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Mentoring-arabic');
  if (!sheet) { Logger.log('Sheet "Mentoring-arabic" not found'); return; }

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

  var sent = 0, failed = 0, skipped = 0;

  try {
    var n        = lastRow - 1;
    var phones   = sheet.getRange(2, PHONE_COL,           n, 1).getValues();
    var statuses = sheet.getRange(2, _waStatusCol(sheet), n, 1).getValues();

    for (var i = 0; i < n; i++) {
      if (!String(phones[i][0]   || '').trim()) continue;   // no number
      if ( String(statuses[i][0] || '').trim()) continue;   // already processed

      var r = _sendRow(sheet, i + 2, url, secret);
      if      (r.status === 'sent')    sent++;
      else if (r.status === 'failed')  failed++;
      else if (r.status === 'skipped') skipped++;

      Utilities.sleep(300); // rate limiting
    }
  } finally {
    lock.releaseLock();
  }

  Logger.log('manualProcessPending: ' + sent + ' sent, ' + failed +
             ' failed, ' + skipped + ' skipped');
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

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Mentoring-arabic');
  if (!sheet) return _json({ error: 'Sheet "Mentoring-arabic" not found' });

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
    var statuses   = sheet.getRange(fromRow, _waStatusCol(sheet),  n, 1).getValues();
    var times      = sheet.getRange(fromRow, _waTimeCol(sheet),    n, 1).getValues();

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
    lastTick:    props.getProperty('AUTO_SEND_LAST_TICK')   || '',
    haltReason:  props.getProperty('AUTO_SEND_HALT_REASON') || '',
    haltAt:      props.getProperty('AUTO_SEND_HALT_AT')     || '',
    minRow:      MIN_ROW_TO_SEND
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
                      .filter(function(r) { return !isNaN(r) && r >= MIN_ROW_TO_SEND; });
  if (rows.length === 0) return _json({ error: 'No valid rows (all below send floor row ' + MIN_ROW_TO_SEND + ')' });

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Mentoring-arabic');
  if (!sheet) return _json({ error: 'Sheet "Mentoring-arabic" not found' });

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
  // Hard floor: never contact rows below MIN_ROW_TO_SEND, no matter who calls us.
  if (row < MIN_ROW_TO_SEND) {
    return { row: row, status: 'skipped', detail: 'below send floor (row ' + MIN_ROW_TO_SEND + ')', httpCode: 0 };
  }

  var phone     = String(sheet.getRange(row, PHONE_COL).getValue()).trim();
  var firstName = String(sheet.getRange(row, FIRST_NAME_COL).getValue()).trim();
  var now       = new Date().toISOString();

  // The Worker dials digits only and rejects anything under 8 of them, so catch
  // that here instead of spending a request to be told. Some rows have a name
  // typed into the phone column.
  var clean = _normPhone(phone);
  if (clean.length < 8) {
    var why = phone ? 'not a usable phone number' : 'no phone';
    sheet.getRange(row, _waStatusCol(sheet)).setValue('WA_SKIPPED: ' + why);
    sheet.getRange(row, _waTimeCol(sheet)).setValue(now);
    return { row: row, status: 'skipped', detail: why };
  }

  // Same person, different row. To message them anyway, clear the status on the
  // row named here first.
  var seen = _sentPhones(sheet);
  if (seen[clean] && seen[clean] !== row) {
    var dupe = 'same number already messaged on row ' + seen[clean];
    sheet.getRange(row, _waStatusCol(sheet)).setValue('WA_SKIPPED: ' + dupe);
    sheet.getRange(row, _waTimeCol(sheet)).setValue(now);
    return { row: row, status: 'skipped', detail: dupe };
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
      sheet.getRange(row, _waStatusCol(sheet)).setValue('WA_SENT: ' + id);
      sheet.getRange(row, _waTimeCol(sheet)).setValue(now);
      seen[clean] = row;   // later rows with this number now skip
      return { row: row, status: 'sent', detail: id, httpCode: httpCode };
    }

    var err = result.error
            || ('HTTP ' + httpCode + (raw ? ' — ' + raw.substring(0, 120) : ' — empty body'));
    sheet.getRange(row, _waStatusCol(sheet)).setValue('WA_FAILED: ' + err);
    sheet.getRange(row, _waTimeCol(sheet)).setValue(now);
    return { row: row, status: 'failed', detail: err, httpCode: httpCode };
  } catch (err) {
    sheet.getRange(row, _waStatusCol(sheet)).setValue('WA_FAILED: ' + err.message);
    sheet.getRange(row, _waTimeCol(sheet)).setValue(now);
    return { row: row, status: 'failed', detail: err.message, httpCode: 0 };
  }
}

// Heuristic: does this error indicate an account-level problem that will keep
// failing every subsequent row? If yes, the auto loop pauses itself instead
// of churning through the queue marking everything WA_FAILED.
//
// Halt signals:
//   - HTTP 401/402/403 (auth revoked, payment required, account suspended)
//   - Detail contains keywords pointing at billing / quota / suspension
function _isAccountFatal(httpCode, detail) {
  if (httpCode === 401 || httpCode === 402 || httpCode === 403) return true;
  var d = String(detail || '').toLowerCase();
  if (!d) return false;
  var keywords = [
    'balance', 'insufficient', 'no funds', 'out of funds', 'no credit',
    'out of credit', 'credit exhausted', 'insufficient credit',
    'payment required', 'billing', 'quota exceeded', 'quota_exceeded',
    'account suspended', 'account_suspended', 'messaging limit',
    'spend cap', 'wallet'
  ];
  for (var i = 0; i < keywords.length; i++) {
    if (d.indexOf(keywords[i]) !== -1) return true;
  }
  return false;
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

  // Re-enabling clears any prior halt — user has acknowledged it.
  if (enabled) {
    props.deleteProperty('AUTO_SEND_HALT_REASON');
    props.deleteProperty('AUTO_SEND_HALT_AT');
  }

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

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Mentoring-arabic');
  if (!sheet) { Logger.log('autoSendTick: sheet not found'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('autoSendTick: lock busy'); return; }

  try {
    // Pull phone (D) and status (AJ) for the whole sheet in two batched reads.
    var n        = lastRow - 1;
    var phones   = sheet.getRange(2, PHONE_COL,     n, 1).getValues();
    var statuses = sheet.getRange(2, _waStatusCol(sheet), n, 1).getValues();

    var picks = [];   // { row, isRetry }
    for (var i = 0; i < n && picks.length < AUTO_BATCH; i++) {
      var absRow = i + 2;
      if (absRow < MIN_ROW_TO_SEND) continue;   // hard floor
      var phone  = String(phones[i][0]   || '').trim();
      var status = String(statuses[i][0] || '').trim();
      if (!phone) continue;

      if (status === '') {
        picks.push({ row: absRow, isRetry: false });
      } else if (retryOnce && status.indexOf('WA_FAILED:') === 0 && status.indexOf('WA_FAILED2:') !== 0) {
        picks.push({ row: absRow, isRetry: true });
      }
    }

    var sent = 0, failed = 0, skipped = 0, halted = false, haltReason = '';
    for (var p = 0; p < picks.length; p++) {
      var r = _sendRowAuto(sheet, picks[p].row, url, secret, picks[p].isRetry);
      if      (r.status === 'sent')    sent++;
      else if (r.status === 'failed')  failed++;
      else if (r.status === 'skipped') skipped++;

      if (r.status === 'failed' && _isAccountFatal(r.httpCode, r.detail)) {
        halted = true;
        haltReason = (r.httpCode ? 'HTTP ' + r.httpCode + ' — ' : '') + r.detail;
        break;
      }

      if (p < picks.length - 1) Utilities.sleep(300);
    }

    props.setProperty('AUTO_SEND_LAST_TICK', new Date().toISOString());

    if (halted) {
      props.setProperty('AUTO_SEND_ENABLED', '0');
      props.setProperty('AUTO_SEND_HALT_REASON', haltReason.substring(0, 300));
      props.setProperty('AUTO_SEND_HALT_AT',     new Date().toISOString());
      installAutoSendTrigger(0);
      Logger.log('autoSendTick: HALTED (' + haltReason + ') after ' +
                 sent + ' sent · ' + failed + ' failed');
    } else {
      Logger.log('autoSendTick: ' + picks.length + ' picked · ' +
                 sent + ' sent · ' + failed + ' failed · ' + skipped + ' skipped');
    }
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
    var current = String(sheet.getRange(row, _waStatusCol(sheet)).getValue());
    if (current.indexOf('WA_FAILED:') === 0) {
      sheet.getRange(row, _waStatusCol(sheet)).setValue('WA_FAILED2:' + current.substring('WA_FAILED:'.length));
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


// -----------------------------------------------------------------
// Column-shift repair tools (run by hand from the editor)
// -----------------------------------------------------------------

/**
 * READ-ONLY diagnostic. Select auditWaColumns > Run, then View > Logs.
 *
 * Reports every column holding WA_SENT / WA_FAILED / WA_SKIPPED values and
 * says whether the script is currently looking at the right one. Run this any
 * time the dashboard suddenly shows thousands of rows as pending: that is the
 * signature of an inserted column having displaced the status column.
 */
function auditWaColumns() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Mentoring-arabic');
  if (!sheet) { Logger.log('Sheet "Mentoring-arabic" not found'); return; }

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) { Logger.log('No data rows'); return; }

  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  var found  = [];

  for (var c = 0; c < lastCol; c++) {
    var sent = 0, failed = 0, skipped = 0;
    for (var r = 0; r < values.length; r++) {
      var v = String(values[r][c] || '');
      if      (v.indexOf('WA_SENT')    === 0) sent++;
      else if (v.indexOf('WA_FAILED')  === 0) failed++;
      else if (v.indexOf('WA_SKIPPED') === 0) skipped++;
    }
    if (sent + failed + skipped > 0) {
      found.push({ col: c + 1, sent: sent, failed: failed, skipped: skipped });
    }
  }

  var active = _waCols(sheet);
  Logger.log('Script is reading and writing column ' + active.status +
             ' (status) and ' + active.time + ' (timestamp)');

  if (found.length === 0) { Logger.log('No WA_* values anywhere in the sheet'); return; }

  for (var i = 0; i < found.length; i++) {
    var f = found[i];
    Logger.log('  column ' + f.col + ': ' + f.sent + ' sent, ' + f.failed +
               ' failed, ' + f.skipped + ' skipped' +
               (f.col === active.status ? '   <-- the one in use' : ''));
  }

  if (found.length < 2) return;

  // More than one column holds statuses. That is only dangerous when a stray
  // column knows about a row the live column does not, because those rows read
  // as never-contacted and would be messaged again. Leftover copies of rows the
  // live column already covers are harmless.
  var unseen = 0;
  for (var j = 0; j < found.length; j++) {
    if (found[j].col === active.status) continue;
    for (var k = 0; k < values.length; k++) {
      var stray = String(values[k][found[j].col - 1] || '');
      var live  = String(values[k][active.status - 1] || '');
      if (stray.indexOf('WA_') === 0 && live.indexOf('WA_') !== 0) unseen++;
    }
  }

  if (unseen > 0) {
    Logger.log('WARNING: ' + unseen + ' rows have a status in another column but ' +
               'none in column ' + active.status + '. The auto loop would message ' +
               'them again. Run migrateWaColumns(<status col>, <timestamp col>) ' +
               'before enabling it.');
  } else {
    Logger.log('OK: column ' + active.status + ' covers every row the other ' +
               'columns know about. The rest are leftover copies and can be cleared.');
  }
}

/**
 * ONE-TIME REPAIR. Consolidates a displaced status pair into the live one.
 *
 * After the Sept 2026 utm_* insert the old history sat in AO/AP, so:
 *     migrateWaColumns(41, 42)
 *
 * Copies only into cells that are currently blank, so anything newer already
 * in the live columns wins and nothing is overwritten. The source columns are
 * left untouched; check the result with auditWaColumns, then clear them by hand.
 */
function migrateWaColumns(fromStatusCol, fromTimeCol) {
  fromStatusCol = parseInt(fromStatusCol, 10);
  fromTimeCol   = parseInt(fromTimeCol, 10);
  if (!fromStatusCol || !fromTimeCol) {
    Logger.log('Call it as migrateWaColumns(<status column>, <timestamp column>), e.g. migrateWaColumns(41, 42)');
    return;
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Mentoring-arabic');
  if (!sheet) { Logger.log('Sheet "Mentoring-arabic" not found'); return; }

  var to = _waCols(sheet);
  if (fromStatusCol === to.status) {
    Logger.log('Source and target are the same column (' + to.status + '); nothing to do');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('No data rows'); return; }
  var n = lastRow - 1;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) { Logger.log('Another execution is running'); return; }

  try {
    var srcStatus = sheet.getRange(2, fromStatusCol, n, 1).getValues();
    var srcTime   = sheet.getRange(2, fromTimeCol,   n, 1).getValues();
    var dstStatus = sheet.getRange(2, to.status,     n, 1).getValues();
    var dstTime   = sheet.getRange(2, to.time,       n, 1).getValues();

    var copied = 0, kept = 0;

    for (var i = 0; i < n; i++) {
      var src = String(srcStatus[i][0] || '').trim();
      var dst = String(dstStatus[i][0] || '').trim();
      if (!src) continue;
      if (dst) { kept++; continue; }       // target already newer, leave it
      dstStatus[i][0] = srcStatus[i][0];
      dstTime[i][0]   = srcTime[i][0];
      copied++;
    }

    sheet.getRange(2, to.status, n, 1).setValues(dstStatus);
    sheet.getRange(2, to.time,   n, 1).setValues(dstTime);

    Logger.log('migrateWaColumns: copied ' + copied + ' rows from column ' +
               fromStatusCol + ' into column ' + to.status + '; left ' + kept +
               ' rows alone because the target already had a newer value.');
    Logger.log('Source column ' + fromStatusCol + ' was NOT cleared. ' +
               'Run auditWaColumns to verify, then clear it manually.');
  } finally {
    lock.releaseLock();
  }
}
