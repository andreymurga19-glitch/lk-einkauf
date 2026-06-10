export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { userMsg, systemMsg, type } = req.body || {};
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  if (!userMsg) return res.status(400).json({ error: 'userMsg required' });

  const body = {
    system_instruction: { parts: [{ text: systemMsg || 'You are a helpful assistant.' }] },
    contents: [{ role: 'user', parts: [{ text: userMsg }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: type === 'info' ? 1000 : 4000 }
  };

  if (type === 'ai') {
    body.tools = [{ google_search: {} }];
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'Gemini error' });
    
    const text = (data.candidates || []).map(c =>
      (c.content?.parts || []).filter(p => p.text).map(p => p.text).join('')
    ).join('');

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
