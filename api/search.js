export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });

  const { userMsg, systemMsg, type } = req.body || {};
  if (!userMsg) return res.status(400).json({ error: 'No userMsg' });

  const BASE_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;

  async function callGemini(prompt, useSearch) {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4000,
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
    if (useSearch) body.tools = [{ google_search: {} }];

    const r = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Gemini error');

    let text = '';
    for (const c of (data.candidates || [])) {
      for (const p of (c.content?.parts || [])) {
        if (p.text) text += p.text;
      }
    }
    return text;
  }

  try {
    if (type === 'info') {
      // Info tab - single call, ask for JSON directly
      const prompt = systemMsg + '\n\n' + userMsg + '\n\nAntwort NUR als JSON-Objekt, kein Text davor oder danach.';
      let text = await callGemini(prompt, false);
      text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const j1 = text.indexOf('{'), j2 = text.lastIndexOf('}');
      if (j1 >= 0 && j2 >= 0) text = text.slice(j1, j2 + 1);
      return res.status(200).json({ text });
    }

    // AI tab - TWO STEPS
    // Step 1: Search with Google Search, get free text results
    const searchPrompt = userMsg;
    const searchResults = await callGemini(searchPrompt, true);

    // Step 2: Format search results as JSON (no google_search tool)
    const formatPrompt = `Du hast folgende Suchergebnisse gefunden:

${searchResults}

Erstelle jetzt NUR ein JSON-Objekt basierend auf diesen Suchergebnissen.
Kein Text vor oder nach dem JSON. Nur das JSON-Objekt.

Format:
{
  "ai_tip": "порада українською мовою",
  "lieferanten": [
    {
      "hersteller": "виробник",
      "produkt_name": "точна назва товару",
      "ean": "EAN або null",
      "artikul": "артикул або null",
      "preis_brutto": 0.00,
      "preis_netto": null,
      "einheit": "12,5L",
      "produkt_url": "посилання або null",
      "shop_name": "де знайдено ціну або null",
      "kontakt_email": null,
      "kontakt_form": null,
      "lieferzeit": "термін або null",
      "vorteil": "перевага українською",
      "nassabrieb": "3"
    }
  ]
}`;

    let jsonText = await callGemini(formatPrompt, false);
    jsonText = jsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const j1 = jsonText.indexOf('{'), j2 = jsonText.lastIndexOf('}');
    if (j1 >= 0 && j2 >= 0) jsonText = jsonText.slice(j1, j2 + 1);

    return res.status(200).json({ text: jsonText });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
