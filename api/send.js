// Vercel serverless proxy for 360dialog WhatsApp API
// Use this if browser-direct calls get blocked by CORS.
// Deploy this file as-is at /api/send.js in your Vercel project.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = req.headers['x-d360-key'];
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing X-D360-Key header' });
  }

  try {
    const upstream = await fetch('https://waba-v2.360dialog.io/messages', {
      method: 'POST',
      headers: {
        'D360-API-KEY': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(req.body)
    });

    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
