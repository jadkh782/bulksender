// Cloudflare Worker — WhatsApp send + auto-send via 360dialog.
//
// Routes:
//   POST /api/send       CORS proxy used by index.html.
//                        Header: X-D360-Key: <360dialog API key>
//                        Body:   raw 360dialog /messages payload
//   POST /api/auto-send  Webhook called by Google Apps Script.
//                        Header: Authorization: Bearer <WEBHOOK_SECRET>
//                        Body:   { phone, name }
//
// Secrets (set with `wrangler secret put <NAME>`):
//   D360_API_KEY    360dialog key, used by /api/auto-send
//   WEBHOOK_SECRET  shared secret matching the Apps Script property
//
// Vars (in wrangler.toml [vars] or via dashboard):
//   TEMPLATE_NAME        approved WhatsApp template
//   TEMPLATE_LANG        language code (default "en")
//   TEMPLATE_PARAM_NAME  named parameter, blank if template has no variables

const D360_URL = 'https://waba-v2.360dialog.io/messages';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-D360-Key',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (pathname === '/api/send')      return handleSend(request);
    if (pathname === '/api/auto-send') return handleAutoSend(request, env);
    if (pathname === '/api/dashboard') return handleDashboard(request);

    if (request.method === 'GET' && pathname === '/api') {
      return json({
        name: 'bulksender',
        ok: true,
        endpoints: {
          'POST /api/send':      'CORS proxy for index.html (header: X-D360-Key)',
          'POST /api/auto-send': 'Apps Script webhook (header: Authorization: Bearer <secret>)'
        }
      });
    }

    return json({ error: 'Not found', path: pathname }, 404);
  }
};

// Browser-side proxy: forwards the payload to 360dialog using the user's key.
async function handleSend(request) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, CORS);
  }

  const apiKey = request.headers.get('x-d360-key');
  if (!apiKey) {
    return json({ error: 'Missing X-D360-Key header' }, 401, CORS);
  }

  try {
    const upstream = await fetch(D360_URL, {
      method: 'POST',
      headers: {
        'D360-API-KEY': apiKey,
        'Content-Type': 'application/json'
      },
      body: await request.text()
    });

    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return json({ error: err.message }, 500, CORS);
  }
}

// Server-side webhook: Apps Script -> here -> 360dialog.
async function handleAutoSend(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || token !== env.WEBHOOK_SECRET) {
    return json({ error: 'Unauthorized' }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { phone, name } = body || {};
  if (!phone) return json({ error: 'Missing phone' }, 400);

  const cleanPhone = String(phone).replace(/[^0-9]/g, '');
  if (cleanPhone.length < 8) {
    return json({ error: 'Invalid phone number' }, 400);
  }

  const templateName = env.TEMPLATE_NAME;
  const langCode     = env.TEMPLATE_LANG || 'en';
  const paramName    = env.TEMPLATE_PARAM_NAME;

  if (!templateName) {
    return json({ error: 'TEMPLATE_NAME not configured' }, 500);
  }

  const template = { name: templateName, language: { code: langCode } };
  if (paramName && name) {
    template.components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', parameter_name: paramName, text: String(name) }
        ]
      }
    ];
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'template',
    template
  };

  try {
    const upstream = await fetch(D360_URL, {
      method: 'POST',
      headers: {
        'D360-API-KEY': env.D360_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await upstream.json();

    if (upstream.ok && data.messages && data.messages[0]) {
      return json({
        success: true,
        messageId: data.messages[0].id,
        phone: cleanPhone
      });
    }

    return json({
      success: false,
      error: data.error?.message || data.message || JSON.stringify(data),
      phone: cleanPhone
    }, upstream.status);
  } catch (err) {
    return json({ success: false, error: err.message, phone: cleanPhone }, 500);
  }
}

// Server-side proxy for the dashboard's calls to Apps Script. Browsers can't
// reliably fetch script.google.com/.../exec cross-origin; the Worker can.
// Forwards extra query params (e.g. fromRow) and POST bodies verbatim.
async function handleDashboard(request) {
  const inUrl  = new URL(request.url);
  const params = inUrl.searchParams;
  const target = params.get('url');
  const token  = params.get('token') || '';

  if (!target || !/^https:\/\/script\.google\.com\/macros\/s\//.test(target)) {
    return json({ error: 'Invalid or missing Apps Script url' }, 400, CORS);
  }

  // Pass through every query param except `url` (already consumed); rebuild
  // the upstream URL so optional things like fromRow flow through.
  const upstream = new URL(target);
  for (const [k, v] of params) {
    if (k === 'url') continue;
    upstream.searchParams.set(k, v);
  }
  if (token) upstream.searchParams.set('token', token);

  const init = { method: request.method, redirect: 'follow' };
  if (request.method === 'POST') {
    init.headers = { 'Content-Type': request.headers.get('content-type') || 'application/json' };
    init.body    = await request.text();
  }

  try {
    const resp = await fetch(upstream.toString(), init);
    return new Response(await resp.text(), {
      status: resp.status,
      headers: { ...CORS, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    return json({ error: err.message }, 502, CORS);
  }
}

function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}
