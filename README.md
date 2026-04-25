# WhatsApp CSV Blaster

Single-page tool for sending templated WhatsApp messages to a list of contacts via 360dialog's Cloud API. Paste your API key, drop a CSV, map the columns, fire.

Plus an automatic mode that fires a template message every time a new Google Form submission lands in your Sheet, and a dashboard that shows live send stats.

## Pieces

| File | What it is |
|---|---|
| `public/index.html` | Single-page UI with two tabs: **Blaster** (manual CSV sends) and **Dashboard** (live auto-send log) |
| `worker.js` | Cloudflare Worker — handles `/api/send` (CORS proxy) and `/api/auto-send` (webhook) |
| `wrangler.toml` | Worker + static-assets deploy config |
| `google-apps-script/Code.gs` | Apps Script — `onFormSubmit` trigger + `doGet` JSON endpoint for the dashboard tab |

The Worker serves the static UI from the same domain. Visiting `https://<your-worker>.workers.dev/` opens the blaster; switch to the Dashboard tab (or hit `/#dashboard` directly) for the live log. `/api/*` routes to the Worker.

## Deploy the Worker

1. Install Wrangler: `npm i -g wrangler`
2. From this folder: `wrangler login`
3. Set the secrets:
   ```
   wrangler secret put D360_API_KEY
   wrangler secret put WEBHOOK_SECRET
   ```
4. (Optional) Edit `wrangler.toml` `[vars]` to override `TEMPLATE_NAME`, `TEMPLATE_LANG`, `TEMPLATE_PARAM_NAME` — or set them in the Cloudflare dashboard.
5. Deploy: `wrangler deploy`

You'll get a URL like `https://bulksender.<your-subdomain>.workers.dev`. Both endpoints live there:
- `POST /api/send` — CORS proxy for `index.html`
- `POST /api/auto-send` — webhook for Apps Script

## Manual mode (`index.html`)

1. Open `index.html` in a browser (or host it on Cloudflare Pages).
2. Paste your 360dialog API key (stays in browser memory only).
3. Upload a CSV — Name and Phone columns are auto-guessed.
4. Adjust column mapping if needed.
5. Enter your approved template name, language, and variable name.
6. Click **Start Sending**.

### CORS fallback

If browser-direct calls to 360dialog get blocked by CORS, tick **"Route via /api/send"**. The request goes through your deployed Worker instead. The Worker reads your key from the `X-D360-Key` header, calls 360dialog, returns the response. Nothing is stored.

The toggle uses the path `/api/send` (relative). If you open `index.html` from `file://` or a domain different from the Worker, change `/api/send` in `index.html` to your full Worker URL.

### Notes

- Phone numbers are auto-stripped of `+`, spaces, and parens before sending.
- Sends are sequential with a 250ms delay between each, to stay clear of rate limits.
- Template variables assume **named parameters** (e.g. `parameter_name: "variable_1"`). Edit the payload builder in `index.html` if you use positional variables.

## Automatic mode (Google Sheets)

```
Google Form submitted
  → new row in "new LEADS" sheet
  → Apps Script fires onFormSubmit
  → POSTs phone + name to <worker>/api/auto-send
  → Worker calls 360dialog
  → Apps Script writes WA_SENT / WA_FAILED to the row
```

### Apps Script setup

1. Open your Google Sheet → **Extensions → Apps Script**.
2. Delete the default code, paste the contents of `google-apps-script/Code.gs`.
3. **Project Settings → Script Properties**, add:
   - `WEBHOOK_URL` = `https://bulksender.<your-subdomain>.workers.dev/api/auto-send`
   - `WEBHOOK_SECRET` = the same value you `wrangler secret put` for the Worker
4. Back in the editor, select **`setupTrigger`** from the dropdown and click **Run**. Authorize when prompted.

### Test

Submit your Google Form. Within a few seconds the new row should show:
- Column AJ: `WA_SENT: <message-id>` or `WA_FAILED: <reason>`
- Column AK: timestamp

### Test the webhook directly

```bash
curl -X POST https://bulksender.<your-subdomain>.workers.dev/api/auto-send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{"phone": "+491234567890", "name": "Test"}'
```

### Retrying failed sends

Clear the WA status cell (Column AJ) for any failed row, then run `manualProcessPending` from the Apps Script editor. It re-processes any row with a phone but no WA status.

## Dashboard tab

Live read-only view of the auto-send log. Stats, 14-day chart, filterable activity table.

### Setup

1. In the Apps Script editor: **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone with the link**
2. Copy the deployed `/exec` URL.
3. Open the Dashboard tab in `index.html`, paste the URL and your `WEBHOOK_SECRET`, hit **Connect**. URL + token are stored in `localStorage` only.

The dashboard polls every 15 seconds *while the tab is active* — switching back to Blaster pauses polling. It reads directly from the Sheet via the `doGet` endpoint in `Code.gs`, independent of the Worker.

## Local development

- Run the Worker locally: `wrangler dev` (uses `.dev.vars` for secrets — gitignored).
- Open `index.html` directly. Direct mode (no proxy) works without a server. Proxy mode requires `wrangler dev` and updating the path if the dev server isn't on the same origin.
