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
