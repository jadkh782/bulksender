// Vercel serverless webhook for automatic WhatsApp sending.
// Called by Google Apps Script when a new form submission arrives.
//
// Required env vars:
//   D360_API_KEY        – 360dialog API key
//   WEBHOOK_SECRET      – shared secret (matches Apps Script property)
//   TEMPLATE_NAME       – approved WhatsApp template name
//   TEMPLATE_LANG       – language code (default "en")
//   TEMPLATE_PARAM_NAME – named parameter in the template (optional)

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verify shared secret
  const auth = req.headers['authorization'] || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || token !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { phone, name } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: 'Missing phone' });
  }

  // Strip non-digits (same logic as index.html)
  const cleanPhone = String(phone).replace(/[^0-9]/g, '');
  if (cleanPhone.length < 8) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  // Build template payload (mirrors index.html lines 687-709)
  const templateName = process.env.TEMPLATE_NAME;
  const langCode = process.env.TEMPLATE_LANG || 'en';
  const paramName = process.env.TEMPLATE_PARAM_NAME;

  if (!templateName) {
    return res.status(500).json({ error: 'TEMPLATE_NAME not configured' });
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
    const upstream = await fetch('https://waba-v2.360dialog.io/messages', {
      method: 'POST',
      headers: {
        'D360-API-KEY': process.env.D360_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await upstream.json();

    if (upstream.ok && data.messages && data.messages[0]) {
      return res.status(200).json({
        success: true,
        messageId: data.messages[0].id,
        phone: cleanPhone
      });
    }

    return res.status(upstream.status).json({
      success: false,
      error: data.error?.message || data.message || JSON.stringify(data),
      phone: cleanPhone
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, phone: cleanPhone });
  }
}
