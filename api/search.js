export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  try {
    const { userMsg, systemMsg, type } = req.body;
    if (!userMsg) return res.status(400).json({ error: 'No userMsg' });

    const fullPrompt = systemMsg ? systemMsg + '\n\n' + userMsg : userMsg;

    const body = {
      contents: [{ parts: [{ text: fullPrompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: type === 'info' ? 1000 : 4000,
        thinkingConfig: { thinkingBudget: 0 }
      }
    };

    if (type === 'ai') {
      body.tools = [{ google_search: {} }];
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }
    );

    const data = await response.json();
    if (!response.ok) {
      return res.status(200).json({ error: 'Gemini: ' + (data.error?.message || JSON.stringify(data)) });
    }

    // Extract ALL text parts from ALL candidates
    let text = '';
    if (data.candidates && data.candidates.length > 0) {
      for (const candidate of data.candidates) {
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if (part.text) text += part.text;
          }
        }
      }
    }

    // Clean up markdown code blocks
    text = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
