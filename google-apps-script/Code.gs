/**
 * Google Apps Script for automatic WhatsApp sending on new form submissions.
 *
 * Install this in your Google Sheet via Extensions > Apps Script.
 *
 * Script Properties (Project Settings > Script Properties):
 *   D360_API_KEY   – 360dialog API key. Present means sends go straight to
 *                    360dialog, which is the route you want. See _sendCfg.
 *   WEBHOOK_SECRET – token the dashboard must present to doGet/doPost. Also the
 *                    bearer token when falling back to the Worker.
 *   WEBHOOK_URL    – only needed for that fallback, e.g.
 *                    https://bulksender.<subdomain>.workers.dev/api/auto-send
 *   TEMPLATE_NAME, TEMPLATE_LANG, TEMPLATE_PARAM_NAME – optional overrides;
 *                    they default to welcome_message / ar / none.
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
var SHEET_NAME = 'Mentoring-arabic';

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

// { status: <1-based col>, time: <1-based col> }, memoized: where NEW outcomes
// get written. Reads never rely on this alone - see _statusAt.
//
// Resolving by label is only possible once the labels exist, and writing them
// is a change to the sheet, so it is opt-in via labelStatusColumns(). Until
// then this falls back to the historical positions and writes nothing.
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

  _waColsCache = { status: status || WA_STATUS_COL, time: time || WA_TIME_COL };
  return _waColsCache;
}

function _waStatusCol(sheet) { return _waCols(sheet).status; }
function _waTimeCol(sheet)   { return _waCols(sheet).time; }

/**
 * OPT-IN, run by hand once from the editor. Writes the two header labels into
 * row 1 above the columns this script already writes, so that a future column
 * insert carries them along and the write target follows automatically.
 *
 * This is the only function here that changes anything outside the two status
 * columns, and it only fills two empty header cells. Everything works without
 * it; you just keep the fixed write position.
 */
function labelStatusColumns() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('Sheet "' + SHEET_NAME + '" not found'); return; }

  var cols = _waCols(sheet);
  var sCell = sheet.getRange(1, cols.status);
  var tCell = sheet.getRange(1, cols.time);

  if (String(sCell.getValue()).trim() || String(tCell.getValue()).trim()) {
    Logger.log('Row 1 above columns ' + cols.status + '/' + cols.time +
               ' is not empty. Nothing written - check them by hand.');
    return;
  }

  sCell.setValue(WA_STATUS_HEADER);
  tCell.setValue(WA_TIME_HEADER);
  Logger.log('Labelled columns ' + cols.status + ' and ' + cols.time);
}


// -----------------------------------------------------------------
// Reading status without rewriting the sheet
// -----------------------------------------------------------------
//
// Sept 2026: five utm_* columns were inserted at J, so ~3,000 completed sends
// moved from AJ/AK to AO/AP while new ones kept landing in AJ. Consolidating
// them would mean rewriting thousands of cells, which is not allowed here, so
// instead every read considers BOTH columns and a row counts as handled if any
// of them says so. New outcomes are still written to one place.

var _gridCache = null;

// One wide read of the data rows, memoized. Apps Script charges per call rather
// than per cell, so a single wide read beats several narrow ones.
function _grid(sheet) {
  if (_gridCache) return _gridCache;
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  _gridCache = (lastRow < 2) ? [] : sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return _gridCache;
}

var _statusColsCache = null;

// Every column holding WA_* values, the live one first.
function _statusCols(sheet) {
  if (_statusColsCache) return _statusColsCache;

  var live  = _waStatusCol(sheet);
  var cols  = [live];
  var rows  = _grid(sheet);
  var width = rows.length ? rows[0].length : 0;

  for (var c = 1; c <= width; c++) {
    if (c === live) continue;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i][c - 1] || '').indexOf('WA_') === 0) { cols.push(c); break; }
    }
  }

  _statusColsCache = cols;
  return _statusColsCache;
}

// The effective status for a row plus the timestamp beside it. The live column
// wins; otherwise the first stranded column that has one. A stranded pair is
// assumed adjacent, which is how every pair in this sheet was written.
function _statusAt(sheet, row) {
  var rows = _grid(sheet);
  var i    = row - 2;
  var none = { status: '', time: '', col: 0 };
  if (i < 0 || i >= rows.length) return none;

  var cols = _statusCols(sheet);
  var live = _waStatusCol(sheet);

  for (var k = 0; k < cols.length; k++) {
    var c = cols[k];
    var v = String(rows[i][c - 1] || '').trim();
    if (!v) continue;
    var tCol = (c === live) ? _waTimeCol(sheet) : c + 1;
    var t    = (tCol - 1 < rows[i].length) ? rows[i][tCol - 1] : '';
    return { status: v, time: t ? String(t).trim() : '', col: c };
  }
  return none;
}

// Writes a row's outcome and keeps the in-memory snapshot in step, so later
// rows in the same run see it.
function _writeStatus(sheet, row, status, when) {
  var sCol = _waStatusCol(sheet);
  var tCol = _waTimeCol(sheet);

  sheet.getRange(row, sCol).setValue(status);
  sheet.getRange(row, tCol).setValue(when);

  var rows = _gridCache;
  var i    = row - 2;
  if (rows && i >= 0 && i < rows.length) {
    if (sCol - 1 < rows[i].length) rows[i][sCol - 1] = status;
    if (tCol - 1 < rows[i].length) rows[i][tCol - 1] = when;
  }
}


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

// { <normalised phone>: <first row that got WA_SENT> }, memoized. Built from the
// merged view, so numbers contacted before the column shift still count.
function _sentPhones(sheet) {
  if (_sentPhonesCache) return _sentPhonesCache;

  var map  = {};
  var rows = _grid(sheet);

  for (var i = 0; i < rows.length; i++) {
    var row = i + 2;
    if (_statusAt(sheet, row).status.indexOf('WA_SENT') !== 0) continue;
    var phone = _normPhone(rows[i][PHONE_COL - 1]);
    if (phone && !map[phone]) map[phone] = row;
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

  if (!_hasTransport(props)) {
    _writeStatus(sheet, row, 'WA_FAILED: no send transport configured', new Date().toISOString());
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
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('Sheet "' + SHEET_NAME + '" not found'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var props  = PropertiesService.getScriptProperties();
  var url    = props.getProperty('WEBHOOK_URL');
  var secret = props.getProperty('WEBHOOK_SECRET');

  if (!_hasTransport(props)) {
    Logger.log('No send transport. Set D360_API_KEY, or both WEBHOOK_URL and WEBHOOK_SECRET, in Script Properties.');
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    Logger.log('Another execution is running');
    return;
  }

  var sent = 0, failed = 0, skipped = 0;

  try {
    var rows = _grid(sheet);

    for (var i = 0; i < rows.length; i++) {
      var absRow = i + 2;
      if (!String(rows[i][PHONE_COL - 1] || '').trim()) continue;   // no number
      if (_statusAt(sheet, absRow).status) continue;                // already handled

      var r = _sendRow(sheet, absRow, url, secret);
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

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) return _json({ error: 'Sheet "' + SHEET_NAME + '" not found' });

  var fromRow = parseInt((e && e.parameter && e.parameter.fromRow) || '2', 10);
  if (isNaN(fromRow) || fromRow < 2) fromRow = 2;

  var lastRow = sheet.getLastRow();
  var stats   = { total: 0, sent: 0, failed: 0, skipped: 0, pending: 0 };
  var entries = [];
  var byDay   = {};

  if (lastRow >= fromRow) {
    var n    = lastRow - fromRow + 1;
    var rows = _grid(sheet);

    for (var i = 0; i < n; i++) {
      var absRow = fromRow + i;
      var src    = rows[absRow - 2] || [];
      var phone  = String(src[PHONE_COL - 1]      || '').trim();
      var name   = String(src[FIRST_NAME_COL - 1] || '').trim();
      var colE   = String(src[COL_E - 1]          || '').trim();
      var colG   = String(src[COL_G - 1]          || '').trim();
      var merged = _statusAt(sheet, absRow);
      var status = merged.status;
      var time   = merged.time;

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
        row:    absRow,
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
  if (!_hasTransport(props))       return _json({ error: 'No send transport. Set D360_API_KEY, or both WEBHOOK_URL and WEBHOOK_SECRET, in Script Properties.' });

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

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) return _json({ error: 'Sheet "' + SHEET_NAME + '" not found' });

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

// -----------------------------------------------------------------
// Talking to 360dialog
// -----------------------------------------------------------------
//
// Two transports. Direct is used whenever a D360_API_KEY Script Property
// exists, and is the one you want.
//
//   direct   Apps Script -> 360dialog
//   webhook  Apps Script -> Cloudflare Worker -> 360dialog
//
// The webhook route broke on 11 Sept 2026. 360dialog answered an ordinary
// machine in 0.34s and is not itself behind Cloudflare, yet every fetch from
// the Worker came back a Cloudflare 522 after ~20s, three times out of three,
// while that same Worker reached script.google.com in 0.33s. Cloudflare's
// network could not open a connection to 360dialog. Nothing in this script
// could fix that, so it stopped routing through it.
//
// The webhook path is kept as a fallback and produces an identical message.

var D360_URL = 'https://waba-v2.360dialog.io/messages';

var _sendCfgCache = null;

// Defaults match what the Worker was configured with, so switching transport
// does not change the message anybody receives.
function _sendCfg() {
  if (_sendCfgCache) return _sendCfgCache;
  var props = PropertiesService.getScriptProperties();
  _sendCfgCache = {
    apiKey:    props.getProperty('D360_API_KEY')        || '',
    template:  props.getProperty('TEMPLATE_NAME')       || 'welcome_message',
    lang:      props.getProperty('TEMPLATE_LANG')       || 'ar',
    paramName: props.getProperty('TEMPLATE_PARAM_NAME') || ''
  };
  return _sendCfgCache;
}

// True when at least one transport is configured.
function _hasTransport(props) {
  return !!(props.getProperty('D360_API_KEY') ||
           (props.getProperty('WEBHOOK_URL') && props.getProperty('WEBHOOK_SECRET')));
}

function _templatePayload(cleanPhone, name, cfg) {
  var template = { name: cfg.template, language: { code: cfg.lang } };
  if (cfg.paramName && name) {
    template.components = [{
      type: 'body',
      parameters: [{ type: 'text', parameter_name: cfg.paramName, text: String(name) }]
    }];
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'template',
    template: template
  };
}

// Reads a 360dialog or Worker reply without assuming it is JSON, because a
// failing edge answers with a plain-text page. Returns { ok, messageId, error,
// httpCode }.
function _readReply(response, pick) {
  var httpCode = response.getResponseCode();
  var raw      = response.getContentText() || '';
  var data     = null;
  try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }

  if (data) {
    var id = pick(httpCode, data);
    if (id) return { ok: true, messageId: id, httpCode: httpCode };
    var msg = (data.error && data.error.message) || data.message || data.error ||
              JSON.stringify(data);
    return { ok: false, error: String(msg), httpCode: httpCode };
  }

  return {
    ok: false,
    httpCode: httpCode,
    error: 'upstream HTTP ' + httpCode + ' (non-JSON): ' +
           (raw.replace(/\s+/g, ' ').trim().substring(0, 120) || 'empty body')
  };
}

function _send360(cleanPhone, name, cfg) {
  return _readReply(
    UrlFetchApp.fetch(D360_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'D360-API-KEY': cfg.apiKey },
      payload: JSON.stringify(_templatePayload(cleanPhone, name, cfg)),
      muteHttpExceptions: true
    }),
    function (code, data) {
      return (code >= 200 && code < 300 && data.messages && data.messages[0])
        ? data.messages[0].id : null;
    });
}

function _sendViaWebhook(phone, name, url, secret) {
  return _readReply(
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'Authorization': 'Bearer ' + secret },
      payload: JSON.stringify({ phone: phone, name: name }),
      muteHttpExceptions: true
    }),
    function (code, data) {
      return (code === 200 && data.success) ? (data.messageId || 'ok') : null;
    });
}

/**
 * Changes nothing and messages nobody. Run it, then View > Logs.
 *
 * Asks 360dialog one question using a deliberately invalid key. A 401 saying
 * "Invalid api token" is the result you want: it proves Apps Script can reach
 * 360dialog, so direct sending will work. A 5xx after roughly 20 seconds means
 * the network path is the problem rather than the credentials.
 */
function test360Reachable() {
  var started = new Date().getTime();
  try {
    var response = UrlFetchApp.fetch(D360_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'D360-API-KEY': 'invalid-probe-key' },
      payload: JSON.stringify({ messaging_product: 'whatsapp', to: '000', type: 'text' }),
      muteHttpExceptions: true
    });
    var secs = ((new Date().getTime() - started) / 1000).toFixed(2);
    var code = response.getResponseCode();
    Logger.log('HTTP ' + code + ' in ' + secs + 's');
    Logger.log('Body: ' + (response.getContentText() || '').substring(0, 200));
    Logger.log(code === 401
      ? 'Reachable. Set D360_API_KEY in Script Properties and sends go direct.'
      : 'Unexpected. A 5xx here means the network path is at fault, not the key.');
  } catch (err) {
    Logger.log('Could not reach 360dialog at all: ' + err.message);
  }
}


// Sends one row, by whichever transport is configured, and writes the outcome.
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
    _writeStatus(sheet, row, 'WA_SKIPPED: ' + why, now);
    return { row: row, status: 'skipped', detail: why };
  }

  // Same person, different row. To message them anyway, clear the status on the
  // row named here first.
  var seen = _sentPhones(sheet);
  if (seen[clean] && seen[clean] !== row) {
    var dupe = 'same number already messaged on row ' + seen[clean];
    _writeStatus(sheet, row, 'WA_SKIPPED: ' + dupe, now);
    return { row: row, status: 'skipped', detail: dupe };
  }

  try {
    var cfg = _sendCfg();
    var r   = cfg.apiKey ? _send360(clean, firstName, cfg)
                         : _sendViaWebhook(phone, firstName, url, secret);

    if (r.ok) {
      _writeStatus(sheet, row, 'WA_SENT: ' + r.messageId, now);
      seen[clean] = row;   // later rows with this number now skip
      return { row: row, status: 'sent', detail: r.messageId, httpCode: r.httpCode };
    }

    _writeStatus(sheet, row, 'WA_FAILED: ' + r.error, now);
    return { row: row, status: 'failed', detail: r.error, httpCode: r.httpCode };
  } catch (err) {
    _writeStatus(sheet, row, 'WA_FAILED: ' + err.message, now);
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
  if (!_hasTransport(props)) {
    Logger.log('autoSendTick: no send transport. Set D360_API_KEY, or both WEBHOOK_URL and WEBHOOK_SECRET, in Script Properties.');
    return;
  }
  var retryOnce = props.getProperty('AUTO_SEND_RETRY') === '1';

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('autoSendTick: sheet not found'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { Logger.log('autoSendTick: lock busy'); return; }

  try {
    // One wide read, then the merged status per row so pre-shift outcomes count.
    var rows  = _grid(sheet);
    var picks = [];   // { row, isRetry }

    for (var i = 0; i < rows.length && picks.length < AUTO_BATCH; i++) {
      var absRow = i + 2;
      if (absRow < MIN_ROW_TO_SEND) continue;   // hard floor
      var phone  = String(rows[i][PHONE_COL - 1] || '').trim();
      if (!phone) continue;
      var status = _statusAt(sheet, absRow).status;

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
      _writeStatus(sheet, row, 'WA_FAILED2:' + current.substring('WA_FAILED:'.length),
                   new Date().toISOString());
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
// Read-only report
// -----------------------------------------------------------------

/**
 * Changes nothing. Select checkStatusColumns > Run, then View > Logs.
 *
 * Shows which columns hold WA_* outcomes, which one new outcomes are written
 * to, and how many rows are still queued. Run it whenever the dashboard numbers
 * look wrong: a sudden jump in "pending" is the signature of a column insert
 * having displaced the status column.
 */
function checkStatusColumns() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  if (!sheet) { Logger.log('Sheet "' + SHEET_NAME + '" not found'); return; }

  var rows = _grid(sheet);
  if (!rows.length) { Logger.log('No data rows'); return; }

  var live = _waStatusCol(sheet);
  var cols = _statusCols(sheet);

  Logger.log('New outcomes are written to column ' + live +
             ' (timestamp ' + _waTimeCol(sheet) + ')');
  Logger.log('Columns consulted when reading, in order: ' + cols.join(', '));

  for (var k = 0; k < cols.length; k++) {
    var c = cols[k], sent = 0, failed = 0, skipped = 0;
    for (var i = 0; i < rows.length; i++) {
      var v = String(rows[i][c - 1] || '');
      if      (v.indexOf('WA_SENT')    === 0) sent++;
      else if (v.indexOf('WA_FAILED')  === 0) failed++;
      else if (v.indexOf('WA_SKIPPED') === 0) skipped++;
    }
    Logger.log('  column ' + c + ': ' + sent + ' sent, ' + failed + ' failed, ' +
               skipped + ' skipped' + (c === live ? '   <-- written to' : '   (read only)'));
  }

  var sent = 0, failed = 0, skipped = 0, queued = 0, noPhone = 0;
  var alreadySent = {};   // phone -> row, from rows that carry WA_SENT
  var queuedRows  = [];

  for (var i = 0; i < rows.length; i++) {
    var row   = i + 2;
    var phone = _normPhone(rows[i][PHONE_COL - 1]);
    var st    = _statusAt(sheet, row).status;

    if (st.indexOf('WA_SENT') === 0) {
      sent++;
      if (phone && !alreadySent[phone]) alreadySent[phone] = row;
    } else if (st.indexOf('WA_FAILED')  === 0) failed++;
    else if   (st.indexOf('WA_SKIPPED') === 0) skipped++;
    else if   (phone.length < 8)               noPhone++;
    else { queued++; queuedRows.push({ row: row, phone: phone }); }
  }

  // Two kinds of repeat: a queued row whose number was contacted long ago, and
  // two queued rows sharing a number. Both get skipped, so neither is a message.
  var oldRepeat = 0, newRepeat = 0;
  var firstQueued = {};
  for (var q = 0; q < queuedRows.length; q++) {
    var ph = queuedRows[q].phone;
    if (alreadySent[ph])        { oldRepeat++; continue; }
    if (firstQueued[ph])        { newRepeat++; continue; }
    firstQueued[ph] = queuedRows[q].row;
  }

  Logger.log('Merged view across those columns:');
  Logger.log('  ' + sent + ' sent, ' + failed + ' failed, ' + skipped + ' skipped');
  Logger.log('  ' + queued + ' rows queued');
  Logger.log('    ' + oldRepeat + ' of them repeat a number already messaged');
  Logger.log('    ' + newRepeat + ' of them repeat another queued row');
  Logger.log('    ' + (queued - oldRepeat - newRepeat) + ' would actually be messaged');
  Logger.log('  ' + noPhone + ' rows have no usable phone number');
  Logger.log('Nothing was changed by this check.');
}
