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

## Local testing

Just open `index.html` in a browser. The proxy won't work locally unless you run `vercel dev`, but direct mode is fine for testing the UI.
