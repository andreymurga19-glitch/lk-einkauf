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

  // ANDRII'S FIXED PROCUREMENT PROMPT - DO NOT MODIFY
  const PROCUREMENT_SYSTEM_PROMPT = `Ти — професійний асистент із закупівель для німецької будівельної компанії "L.K Bauservice". Твоє завдання — аналізувати артикули з нашої номенклатури 1С, розуміти їхнє точне призначення та технічні характеристики, а також знаходити найкращі джерела постачання в Німеччині.

АЛГОРИТМ АНАЛІЗУ ТОВАРУ (КРОК ЗА КРОКОМ):
1. Визначення призначення: Проаналізуй позицію (наприклад, "MegaGrund 353" -> грунтовка/фарба для стін 3-го класу стирання / Nassabriebklasse 3; "Валик поролоновий 110мм" -> поролоновий валик для фарбування дверей лаком).
2. Звірка з каталогом LWS/EGLWS: Перевір, які бренди чи класи якості прописані для соціального житла (наприклад, Brillux).
3. Регіональний пошук: Сфокусуйся на регіоні Зальцгіттер (Salzgitter, індекс 38226), Брауншвайг (Braunschweig) та Нижня Саксонія.

СУВОРИЙ ПОРЯДОК ПОШУКУ ТА ДЖЕРЕЛА:
1. Großhandel (MEGA eG, Brillux, Schlau Großhandel): Тут ти зобов'язаний знайти точний артикул (Artikelnummer) відповідного класу якості. Якщо ціни закриті через необхідність логіну, став статус "Ціну потрібно уточнити".
2. Baumärkte (Globus Baumarkt у Зальцгіттері, Hornbach у Брауншвайгу, Sonderpreis Baumarkt): Тут ти зобов'язаний знайти точний артикул, актуальну ціну та пряме посилання на товар.
3. Топ-онлайн-магазини та Amazon: Шукай дешевші альтернативи для розхідників (валики, наждачні диски для жирафа). Вказівка артикула, ціни та прямого посилання є обов'язковою.

СУВОРІ ПРАВИЛА ПРОТИ ГАЛЮЦИНАЦІЙ (ANTI-HALLUCINATION):
- Жодних вигаданих даних: Категорично заборонено вигадувати артикули або ціни.
- Немає артикула = немає рекомендації: Якщо для товару не знайдено точного артикула, ти не маєш права рекомендувати цю позицію.
- Прямі посилання (Deep Links) замість головних сторінок: Усі посилання МАЮТЬ бути прямими лінками на сторінку конкретного товару, щоб закупник не шукав його вручну. Посилання просто на "brillux.de" або "hornbach.de" вважаються недійсними.
- ЦЕ ПРАВИЛО СТОСУЄТЬСЯ АБСОЛЮТНО ВСІХ ТОВАРІВ у будь-якій категорії номенклатури — фарби, радіатори, сантехніка (крани, змішувачі), ламінат, гіпсокартон, електрика, інструменти тощо. Незалежно від категорії, КОЖНА рекомендація МАЄ містити: точний артикул + пряме посилання на сторінку товару.
- Ціна в Baumarkt ЗАВЖДИ обов'язкова: Baumarkt-сайти (Hornbach, Bauhaus, OBI, Globus, Hagebau, Toom тощо) показують ціни публічно без логіну. Тому для категорії "Baumarkt" статус "Ціну потрібно уточнити" НЕ ДОПУСКАЄТЬСЯ — якщо ти знайшов товар на сайті Baumarkt, ти зобов'язаний знайти і його ціну на тій же сторінці. "Ціну потрібно уточнити" дозволяється ТІЛЬКИ для категорії Großhandel (де ціни часто закриті логіном).
- Автоматична чернетка листа: Якщо для Großhandel (наприклад, Brillux) ціну знайти не вдалося, автоматично створи офіційний запит ціни (Preisanfrage) німецькою мовою від імені "L.K Bauservice" (наприклад: "Sehr geehrte Damen und Herren, wir von L.K Bauservice benötigen ein Angebot für...").`;


  // Repair JSON: escape literal newlines/tabs/CR that occur inside string values
  function sanitizeJson(str) {
    let result = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (escaped) {
        result += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        result += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        result += ch;
        continue;
      }
      if (inString && ch === '\n') { result += '\\n'; continue; }
      if (inString && ch === '\r') { result += '\\r'; continue; }
      if (inString && ch === '\t') { result += '\\t'; continue; }
      result += ch;
    }
    return result;
  }

  try {
    if (type === 'info') {
      const prompt = systemMsg + '\n\n' + userMsg + '\n\nAntwort NUR als JSON-Objekt, kein Text davor oder danach.';
      let text = await callGemini(prompt, false);
      text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const j1 = text.indexOf('{'), j2 = text.lastIndexOf('}');
      if (j1 >= 0 && j2 >= 0) text = text.slice(j1, j2 + 1);
      text = sanitizeJson(text);
      return res.status(200).json({ text });
    }

    // AI tab - TWO STEPS using Andrii's fixed prompt
    // Step 1: Search with Google Search using the fixed procurement prompt
    const searchPrompt = PROCUREMENT_SYSTEM_PROMPT + '\n\n---\n\n' + userMsg;
    const searchResults = await callGemini(searchPrompt, true);

    // Step 2: Format search results as JSON matching the required output structure
    const formatPrompt = `Du hast folgende Recherche-Ergebnisse:

${searchResults}

Erstelle jetzt NUR ein JSON-Objekt basierend auf diesen Ergebnissen, gemäß folgender Struktur (alle Texte auf Ukrainisch, außer Briefvorlage auf Deutsch):
Kein Text vor oder nach dem JSON. Nur das JSON-Objekt.

{
  "tovar_1c": "Назва товару з 1С",
  "pryznachennya": "Призначення/Клас (наприклад, Фарба для стін Клас 3 / Поролоновий валик 110мм)",
  "ai_tip": "коротка порада українською",
  "lieferanten": [
    {
      "kategoriya": "Großhandel | Baumarkt | Online/Amazon",
      "hersteller": "Виробник або магазин",
      "produkt_name": "точна назва товару",
      "artikul": "точний артикул або null - якщо null, ЦЯ ПОЗИЦІЯ НЕ МАЄ БУТИ РЕКОМЕНДОВАНА",
      "ean": "EAN або null",
      "preis_brutto": число або null,
      "preis_status": "ціна знайдена | Ціну потрібно уточнити",
      "einheit": "одиниця",
      "produkt_url": "ПРЯМЕ посилання на сторінку товару (deep link), НЕ головна сторінка сайту",
      "vorteil": "перевага українською"
    }
  ],
  "preisanfrage_brief": "Якщо для Großhandel ціна не знайдена - офіційний лист-запит ціни німецькою мовою від L.K Bauservice (Sehr geehrte Damen und Herren, wir von L.K Bauservice...), інакше null"
}`;

    let jsonText = await callGemini(formatPrompt, false);
    jsonText = jsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const j1 = jsonText.indexOf('{'), j2 = jsonText.lastIndexOf('}');
    if (j1 >= 0 && j2 >= 0) jsonText = jsonText.slice(j1, j2 + 1);

    jsonText = sanitizeJson(jsonText);
    return res.status(200).json({ text: jsonText });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
