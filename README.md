# WhatsApp CSV Blaster

Single-page tool for sending templated WhatsApp messages to a list of contacts via 360dialog's Cloud API. Paste your API key, drop a CSV, map the columns, fire.

## Deploy

**Fastest path:**
1. Create a new GitHub repo, commit both files (`index.html` and `api/send.js`)
2. Import the repo on [vercel.com/new](https://vercel.com/new)
3. Deploy (no config needed)

Or drag the whole folder onto Vercel's drag-and-drop deploy.

## Usage

1. Open your deployed URL
2. Paste your 360dialog API key (stays in browser memory only)
3. Upload a CSV — Name and Phone columns will be auto-guessed
4. Adjust the column mapping if needed
5. Enter your approved template name, language code, and variable name
6. Click Start Sending

## CORS fallback

If the browser blocks the direct API call to 360dialog, tick the **"Route via /api/send"** checkbox. That routes your request through the bundled Vercel serverless proxy (`api/send.js`) which forwards it server-side — CORS-free.

The proxy doesn't store your API key. It just reads it from the `X-D360-Key` header, makes the upstream call, and returns the response.

## Notes

- Phone numbers are auto-stripped of `+`, spaces, and parens before sending
- Requests are sequential with a 250ms delay between each, to stay clear of rate limits
- Template variables assume **named parameters** (e.g. `parameter_name: "variable_1"`). If your template uses positional variables, you'll need to edit the payload builder in `index.html`
- Nothing is stored. Close the tab = key and CSV are gone.

## Automatic Mode (Google Sheets)

Send a WhatsApp template message automatically every time a new Google Form submission lands in your Sheet.

### How it works

```
Google Form submitted
  → new row in "new LEADS" sheet
  → Apps Script fires onFormSubmit trigger
  → POSTs phone + name to /api/auto-send
  → Vercel calls 360dialog API
  → Script writes WA_SENT / WA_FAILED back to the row
```

### Step 1: Vercel environment variables

In your Vercel dashboard → Project Settings → Environment Variables, add:

| Variable | Value |
|---|---|
| `D360_API_KEY` | Your 360dialog API key |
| `WEBHOOK_SECRET` | A random secret string (e.g. run `openssl rand -hex 32`) |
| `TEMPLATE_NAME` | Your approved WhatsApp template name |
| `TEMPLATE_LANG` | Language code, e.g. `en` or `ar` |
| `TEMPLATE_PARAM_NAME` | Named parameter in the template (e.g. `variable_1`), or leave empty if no variables |

Then redeploy so the new `api/auto-send.js` endpoint goes live.

### Step 2: Google Apps Script

1. Open your Google Sheet → **Extensions → Apps Script**
2. Delete the default code and paste the contents of `google-apps-script/Code.gs`
3. Go to **Project Settings** (gear icon) → **Script Properties** and add:
   - `WEBHOOK_URL` = `https://your-app.vercel.app/api/auto-send`
   - `WEBHOOK_SECRET` = the same secret you set in Vercel
4. Back in the editor, select **`setupTrigger`** from the function dropdown and click **Run**
5. Authorize the script when prompted (it needs permission to access the Sheet and make HTTP requests)

### Step 3: Test

Submit your Google Form. Within a few seconds the new row should show:
- Column AJ: `WA_SENT: <message-id>` or `WA_FAILED: <reason>`
- Column AK: Timestamp of when the send was attempted

### Retrying failed sends

Clear the WA status cell (Column AJ) for any failed row, then run `manualProcessPending` from the Apps Script editor. It will re-process all rows that have a phone number but no WA status.

### Testing the webhook directly

```bash
curl -X POST https://your-app.vercel.app/api/auto-send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{"phone": "+491234567890", "name": "Test"}'
```

## Local testing

Just open `index.html` in a browser. The proxy won't work locally unless you run `vercel dev`, but direct mode is fine for testing the UI.
