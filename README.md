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
  → new row in "Mentoring-arabic" sheet
  → Apps Script fires onFormSubmit
  → Apps Script calls 360dialog
  → Apps Script writes WA_SENT / WA_FAILED to the row
```

### Why the Worker is not in that path

It used to be, and on 11 September 2026 it stopped working. Measured three ways:

| From | To | Result |
|---|---|---|
| An ordinary machine | 360dialog | HTTP 401 JSON in 0.34s |
| The Cloudflare Worker | 360dialog | HTTP 522 in 19.7s, three out of three |
| The Cloudflare Worker | script.google.com | HTTP 404 in 0.33s |

360dialog was healthy, answers in a third of a second, and is not itself behind
Cloudflare. The Worker's egress was fine for other hosts. The single broken hop
was Cloudflare's network opening a connection to 360dialog, which it could not
do, so Cloudflare synthesised a 522 after its connect timeout.

Nothing in this repo could fix that, so the send path stopped going through it.
Apps Script runs on Google's network and reaches 360dialog directly. The Worker
still serves the UI and still proxies the dashboard's calls to Apps Script, both
of which work.

The payload is unchanged. A test asserts the JSON Apps Script sends is identical
to what the Worker used to send, so nobody receives a different message.

### Apps Script setup

1. Open your Google Sheet → **Extensions → Apps Script**.
2. Delete the default code, paste the contents of `google-apps-script/Code.gs`.
3. **Project Settings → Script Properties**, add:
   - `D360_API_KEY` = your 360dialog API key. Its presence is what selects the direct route.
   - `WEBHOOK_SECRET` = any long random string. The dashboard must present it to connect.
4. Select **`test360Reachable`** from the dropdown and **Run**. It messages nobody.
   A `HTTP 401 … Invalid api token` reply is the good outcome: it proves Apps
   Script can reach 360dialog. A 5xx after ~20 seconds means the network path is
   at fault rather than the key.
5. Select **`setupTrigger`** and **Run**. Authorize when prompted.

Optional, only if you ever want the Worker back in the path: drop `D360_API_KEY`
and set `WEBHOOK_URL` to `https://bulksender.<subdomain>.workers.dev/api/auto-send`
with `WEBHOOK_SECRET` matching the Worker's. `TEMPLATE_NAME`, `TEMPLATE_LANG` and
`TEMPLATE_PARAM_NAME` are optional overrides and default to `welcome_message`,
`ar` and none.

### Test

Submit your Google Form. Within a few seconds the new row should show:
- `WA_SENT: <message-id>` or `WA_FAILED: <reason>` under the **WA Status** header
- a timestamp under the **WA Sent At** header

### What this script is allowed to change

Only two cells per row it processes: the status and its timestamp. Nothing else
in the sheet is ever written. Lead data, the manual `statuis` column and the
older status columns are read and left alone.

There is exactly one exception, and it is opt-in: `labelStatusColumns()` writes
two header labels into row 1, and only if those cells are empty. See below.

### Finding the status, after the columns moved

In September 2026 five `utm_*` columns were inserted at J. Everything to their
right shifted five places, so about 3,000 completed sends moved from AJ/AK to
AO/AP while new ones kept landing in AJ. The script was reading AJ only, so it
lost sight of those 3,000 people and would have messaged all of them again.

Consolidating the two columns would mean rewriting thousands of cells, so the
script does not do that. Instead **reads consider every column that holds
`WA_*` values**, and a row counts as handled if any of them says so. New
outcomes are still written to one place, so the sheet does not sprawl.

Run `checkStatusColumns()` from the editor to see which columns are in play. It
changes nothing. Run it whenever the dashboard numbers look wrong: a jump in
"pending" is the signature of another column insert.

`labelStatusColumns()` is the optional tidy-up. It writes `WA Status` and
`WA Sent At` into row 1 above the two columns the script writes, so a future
insert carries the labels along and the write position follows automatically.
Without it the write position stays fixed at AJ/AK, which is still safe because
reads are merged either way.

### Testing on new arrivals only

The two automatic paths do different things, and it is worth being clear about
which one you are switching on.

| | What it messages |
|---|---|
| `onFormSubmit` trigger | only the row that was just submitted |
| `autoSendTick` loop | every row with no status, oldest first |

The loop drains the backlog. On the current sheet that is 928 rows going back to
May, and it reaches today's leads last. That is rarely what you want on a first
run.

To test the form trigger safely, run **`armNewRowsOnly()`** from the editor. It
reads where the sheet ends and puts the send floor one row above it, so every
lead already present becomes unreachable by every send path and only rows added
afterwards can be contacted. It writes a Script Property, never a sheet cell.
Undo with `clearRowFloor()`.

The floor is enforced inside `_sendRow`, so the loop, a dashboard send and the
form trigger all obey it. `MIN_ROW_TO_SEND` in the script is an absolute minimum
that the property can raise but never lower; negative or non-numeric values are
ignored.

### Not messaging the same person twice

473 numbers in this sheet appear on more than one row, because people fill the
form more than once. A per-row status is therefore not enough on its own. Every
send path checks the **number**, not just the row: if the same number already
has a `WA_SENT` anywhere in the sheet, the row is marked
`WA_SKIPPED: same number already messaged on row N` instead of being sent.

To message somebody deliberately anyway, clear the status on the row it names
first. Rows whose phone column holds fewer than 8 digits (a few contain a name)
are skipped locally rather than spending a request to be rejected.

All three entry points, the form trigger, the dashboard and the auto loop, go
through one function, `_sendRow`, so the hard floor, the duplicate check and the
response handling cannot drift apart between them.

### Test the webhook directly

```bash
curl -X POST https://bulksender.<your-subdomain>.workers.dev/api/auto-send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_WEBHOOK_SECRET" \
  -d '{"phone": "+491234567890", "name": "Test"}'
```

### Retrying failed sends

Clear the status cell for any failed row, column AJ unless you have run `labelStatusColumns()`, then run `manualProcessPending` from the Apps Script editor. It re-processes any row with a phone and no status in any of the columns it reads.

Failures whose reason begins `upstream HTTP 5xx (non-JSON)` are transient: 360dialog sat behind a Cloudflare edge that could not reach it. They are always worth retrying. The response also carries `retryable: true` for those.

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
