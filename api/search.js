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

  // Follow Google's vertexaisearch redirect to get the real destination URL.
  // Gemini's groundingChunks.web.uri is ALWAYS a redirect wrapper, never the real page —
  // this is a documented Gemini API limitation (no field exposes the original URL directly).
  // Resolving it server-side is the only reliable way to get a working deep link.
  async function resolveRedirect(redirectUrl) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      const r = await fetch(redirectUrl, { method: 'GET', redirect: 'follow', signal: controller.signal });
      clearTimeout(timeoutId);
      if (r.url && !r.url.includes('vertexaisearch.cloud.google.com')) {
        return r.url;
      }
      return null;
    } catch {
      return null;
    }
  }

  async function callGemini(prompt, useSearch, jsonMode) {
    const body = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 4000,
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
    if (useSearch) body.tools = [{ google_search: {} }];
    if (jsonMode) body.generationConfig.responseMimeType = 'application/json';

    const r = await fetch(BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'Gemini error');

    let text = '';
    const rawChunks = [];
    for (const c of (data.candidates || [])) {
      for (const p of (c.content?.parts || [])) {
        if (p.text) text += p.text;
      }
      const chunks = c.groundingMetadata?.groundingChunks || [];
      for (const chunk of chunks) {
        if (chunk.web?.uri) {
          rawChunks.push({ title: chunk.web.title || '', redirectUri: chunk.web.uri });
        }
      }
    }

    // Resolve all redirect URIs to their real destination in parallel
    const resolved = await Promise.all(
      rawChunks.map(async (c) => ({ title: c.title, uri: await resolveRedirect(c.redirectUri) }))
    );
    const sources = resolved.filter((s) => s.uri);

    return { text, sources };
  }

  // ANDRII'S FIXED PROCUREMENT PROMPT - DO NOT MODIFY
  const PROCUREMENT_SYSTEM_PROMPT = `Ти — професійний асистент із закупівель для німецької будівельної компанії "L.K Bauservice". Твоє завдання — аналізувати артикули з нашої номенклатури 1С, розуміти їхнє точне призначення та технічні характеристики, а також знаходити найкращі джерела постачання в Німеччині.

КРИТИЧНО — ТИП ВИМОГИ LWS (визнач ПЕРШИМ кроком, ще до пошуку):
У полі "LWS-Anforderung" в даних товару міститься префікс, що ОДНОЗНАЧНО визначає тип вимоги до бренду. Розпізнай префікс і застосуй ВІДПОВІДНУ логіку пошуку нижче — це найважливіше рішення в усьому алгоритмі, воно визначає всю подальшу стратегію:

▶ [КАТ.1 — Без вимоги] — бренд НЕ важливий, єдиний критерій — ЦІНА.
  - НЕ шукай і НЕ згадуй жоден конкретний бренд як вимогу.
  - Шукай ідентичний або максимально схожий товар (за призначенням, розміром, технічними характеристиками) у будь-якого постачальника — Großhandel, Baumarkt, Amazon — і обирай найдешевший варіант.
  - В ai_tip явно зазнач: "Бренд не регламентований LWS — орієнтуйся на найкращу ціну."
  - НЕ застосовуй обмеження "KEINE BAUMARKTARTIKEL" для цієї категорії, якщо явно не вказано інше.

▶ [КАТ.2 — Клас/стандарт LWS] — вимога до КЛАСУ/СТАНДАРТУ, а НЕ до одного бренду. У тексті вимоги перелічені 2+ рівноцінних виробники (наприклад "Brillux/Herbol/Relius/Sto/Caparol/MEGA" або "Schomburg/Botament/Ardex/PCI/MAPEI/RYWA").
  - Твоє завдання — знайти товари ВІД РІЗНИХ ВИРОБНИКІВ зі списку, що відповідають вказаному класу/параметру (напр. Nassabriebklasse 3, RAL 9010, Fugenfarbe silbergrau/anthrazit).
  - У результаті lieferanten МАЄ бути представлено МІНІМУМ 2-3 РІЗНІ бренди з переліку як рівноцінні альтернативи — це не один "переможець", а кілька легітимних варіантів для порівняння ціни.
  - НЕ обирай довільний бренд поза переліком вимоги, якщо в самій вимозі явно не сказано "або еквівалент" без обмеження списку.
  - Якщо вимога містить позначку "KEINE BAUMARKTARTIKEL" — категорично НЕ шукай у Hornbach/Bauhaus/OBI/Globus для цього товару; шукай лише у Großhandel або спеціалізованих онлайн-магазинах фарб.

▶ [КАТ.3 — Закритий бренд LWS] — вимога до ОДНОГО конкретного бренду/моделі (наприклад VIGOUR One, TRINNITY, PRÜM, Cosmo, Busch Jaeger Reflex SI, MEGA BasicLine).
  - Шукай ТІЛЬКИ цей бренд/модель — в різних магазинах (Großhandel, Baumarkt, Amazon), але БЕЗ альтернативних брендів.
  - Якщо в lws_req є позначка "⚠️ інший бренд, не в стандарті LWS" — це означає що ПОТОЧНА позиція 1С сама є відхиленням від еталону. У такому разі: (а) знайди ціну на ТОЧНО ТОЙ САМИЙ товар що в 1С (поточний бренд), і (б) додатково зазнач в ai_tip який бренд є справжнім еталоном LWS згідно вимоги, та порадь розглянути заміну.
  - Якщо позначка "✅ Відповідає стандарту LWS" — товар вже відповідає еталону, шукай тільки актуальну ціну цього самого бренду/моделі в різних магазинах.

Якщо поле "LWS-Anforderung" відсутнє або не містить жодного з префіксів [КАТ.1/2/3] — трактуй товар як категорію 1 (без вимоги, орієнтир на ціну).

АЛГОРИТМ АНАЛІЗУ ТОВАРУ (КРОК ЗА КРОКОМ):
1. Визначення призначення: Проаналізуй позицію (наприклад, "MegaGrund 353" -> грунтовка/фарба для стін 3-го класу стирання / Nassabriebklasse 3; "Валик поролоновий 110мм" -> поролоновий валик для фарбування дверей лаком).
2. Визначення типу вимоги LWS: застосуй розділ "КРИТИЧНО — ТИП ВИМОГИ LWS" вище.
3. Регіональний пошук: Сфокусуйся на регіоні Зальцгіттер (Salzgitter, індекс 38226), Брауншвайг (Braunschweig) та Нижня Саксонія.

СУВОРИЙ ПОРЯДОК ПОШУКУ ТА ДЖЕРЕЛА:
1. Großhandel: оптовий постачальник, РЕЛЕВАНТНИЙ ДЛЯ КОНКРЕТНОЇ КАТЕГОРІЇ товару — НЕ фіксований список! Визнач категорію товару і шукай відповідного Großhandel:
   - Фарби/шпалери/малярні матеріали: MEGA eG, Brillux, Schlau Großhandel
   - Електрика/кабель/освітлення: Elektro-Großhandel (напр. Sonepar, Rexel, F&G Elektro-Großhandel, Elektro Hennig, Schäcke)
   - Сантехніка/опалення: Sanitär-Großhandel (напр. Richter+Frenzel, GC-Gruppe/GC Elektroglas, Brink)
   - Будматеріали/гіпсокартон/деревина: Stark, Raab Karcher, Bauking
   ЗАБОРОНЕНО вказувати постачальника з невідповідної категорії (наприклад MEGA eG для кабелю) лише тому що він був релевантним для іншого товару раніше в розмові. Якщо точний релевантний Großhandel не знайдено реальним пошуком — НЕ вигадуй назву, краще пропусти цю групу повністю.
   Якщо ціни закриті через необхідність логіну, став статус "Ціну потрібно уточнити".
2. Baumärkte (Globus Baumarkt у Зальцгіттері, Hornbach у Брауншвайгу, Sonderpreis Baumarkt): Тут ти зобов'язаний знайти точний артикул, АКТУАЛЬНУ ЦІНУ (число) та пряме посилання на товар — УСІ ТРИ поля одночасно.
3. Топ-онлайн-магазини та Amazon: Шукай дешевші альтернативи для розхідників (валики, наждачні диски для жирафа). Вказівка артикула, ціни та прямого посилання є обов'язковою.

КРИТИЧНО ПРО BAUMARKT — "ВСЕ АБО НІЧОГО":
Якщо для Baumarkt-постачальника ти знайшов артикул товару, але НЕ зміг знайти ЧИСЛОВУ ЦІНУ на тій самій сторінці — це означає що товар НЕ підтверджено повністю. У такому разі ПОВНІСТЮ ВИКЛЮЧИ цього постачальника з результату (не додавай його в масив lieferanten взагалі). НІКОЛИ не показуй для Baumarkt запис з артикулом але без ціни і статусом "Ціну потрібно уточнити" — такий статус для Baumarkt СУВОРО ЗАБОРОНЕНИЙ за будь-яких обставин. Краще менше постачальників, але кожен — повністю підтверджений (артикул + ціна + посилання).

ОБОВ'ЯЗКОВІ ОКРЕМІ ПОШУКОВІ ЗАПИТИ ДЛЯ КОЖНОЇ КАТЕГОРІЇ МАГАЗИНІВ:
Ти зобов'язаний виконати МІНІМУМ по одному окремому google_search запиту для КОЖНОЇ з 3 категорій магазинів вище — це означає МІНІМУМ 3 окремих пошуки на кожен товар, незалежно від того, наскільки "очевидним" здається результат:
- Пошук №1: товар + назва Großhandel (наприклад "Schlau Großhandel Tapetenkleister")
- Пошук №2: товар + назва конкретного Baumarkt (наприклад "Hornbach Tapetenkleister 25kg" або "Bauhaus Tapetenkleister")
- Пошук №3: товар + "Amazon" або назва онлайн-магазину
ВИНЯТОК: якщо товар має позначку "KEINE BAUMARKTARTIKEL" в lws_req (категорія 2, докладніше в розділі "КРИТИЧНО — ТИП ВИМОГИ LWS" вище) — пропусти Пошук №2 в Baumarkt і замість нього виконай пошук серед спеціалізованих онлайн-магазинів фарб або сайту виробника напряму.
НЕ пропускай категорію Baumarkt лише тому що товар "професійний" — Hornbach/Bauhaus/OBI продають більшість будматеріалів, включно з клеями, грунтовками, інструментом. Якщо після реального пошуку в Baumarkt справді нічого не знайдено — напиши в ai_tip explicit: "У Baumarkt цей товар не знайдено", але сам пошук ОБОВ'ЯЗКОВИЙ (окрім вищевказаного винятку KEINE BAUMARKTARTIKEL).

ВАЖЛИВО ПРО ПОСИЛАННЯ: Тобі НЕ потрібно самостійно писати URL-адреси в тексті — система автоматично збирає реальні перевірені посилання з результатів твого пошуку (`google_search`) окремим механізмом. Зосередься на тому, щоб через `google_search` дійсно відвідати/знайти конкретну сторінку товару (а не лише головну сторінку магазину) для кожного постачальника, який ти називаєш — це підвищує шанс, що система знайде відповідне реальне посилання.

ЗАГАЛЬНІ/ПОШИРЕНІ ТОВАРИ (кабелі, кріплення, наждачний папір, базова фурнітура) — продаються практично у КОЖНОМУ Baumarkt/Großhandel. Для таких товарів НЕ здавайся після одного пошуку — якщо перший запит не дав результату, спробуй інше формулювання (інша назва магазину, інше написання товару). "Не знайшов жодного артикула" для типового масового товару (наприклад NYM-J кабель 3x1,5) є СИГНАЛОМ, що пошук виконано недостатньо — спробуй ще раз з іншими запитами, перш ніж визнавати що товару немає.

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
      let { text } = await callGemini(prompt, false, true);
      text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
      const j1 = text.indexOf('{'), j2 = text.lastIndexOf('}');
      if (j1 >= 0 && j2 >= 0) text = text.slice(j1, j2 + 1);
      text = sanitizeJson(text);
      return res.status(200).json({ text });
    }

    // AI tab - TWO STEPS using Andrii's fixed prompt
    // Step 1: Search with Google Search using the fixed procurement prompt
    const searchPrompt = PROCUREMENT_SYSTEM_PROMPT + '\n\n---\n\n' + userMsg;
    const { text: searchResults, sources } = await callGemini(searchPrompt, true);

    // sources now contain REAL resolved destination URLs (redirect already followed in callGemini).
    // Deduplicate by final URL.
    const seenUris = new Set();
    const uniqueSources = [];
    for (const s of sources) {
      if (seenUris.has(s.uri)) continue;
      seenUris.add(s.uri);
      uniqueSources.push(s);
    }
    let sourcesList = uniqueSources.length
      ? uniqueSources.map((s, idx) => `[${idx + 1}] domain: ${s.title || '(unbekannt)'} | echte URL: ${s.uri}`).join('\n')
      : '(Keine verifizierten Quellen-URLs gefunden)';

    // Step 2: Format search results as JSON matching the required output structure
    const formatPrompt = `Du hast folgende Recherche-Ergebnisse:

${searchResults}

ECHTE, VERIFIZIERTE QUELLEN-URLS (das sind die EINZIGEN URLs, die du verwenden darfst):
${sourcesList}

Erstelle jetzt NUR ein JSON-Objekt basierend auf diesen Ergebnissen, gemäß folgender Struktur (alle Texte auf Ukrainisch, außer Briefvorlage auf Deutsch):
Kein Text vor oder nach dem JSON. Nur das JSON-Objekt.

KRITISCH ZU produkt_url — NEUE REGEL:
Der Recherche-Text oben kann Zeilen "URL: <adresse>" enthalten — IGNORIERE DIESE ZEILEN VOLLSTÄNDIG, sie sind oft vom Modell erfunden/rekonstruiert und führen zu 404-Fehlern. Die EINZIGE gültige Quelle für produkt_url ist die Liste "ECHTE, VERIFIZIERTE QUELLEN-URLS" oben — das sind echte URLs, die durch tatsächliches Auflösen von Suchergebnis-Links gewonnen wurden.
Für jedes Produkt in lieferanten:
1. Suche in der Liste "ECHTE, VERIFIZIERTE QUELLEN-URLS" nach einem Eintrag, dessen Domain/Titel zum Hersteller/Shop dieses Produkts passt (z.B. wenn hersteller="Hornbach", suche einen Eintrag mit domain "hornbach.de").
2. Wenn ein passender Eintrag existiert: kopiere die "echte URL" EXAKT (Zeichen für Zeichen) als produkt_url.
3. Wenn KEIN passender Eintrag in der Liste existiert: setze produkt_url auf null. NIEMALS eine URL erfinden, raten, kürzen oder aus dem Text rekonstruieren - exakte Kopie aus der Liste oder null, keine dritte Option.

KRITISCH — DEDUPLIZIERUNG VON LIEFERANTEN:
Wenn im Recherche-Text derselbe Lieferant/Hersteller mehrmals erscheint (z.B. weil mehrere Suchanfragen denselben Shop gefunden haben), darf er NUR EINMAL im lieferanten-Array erscheinen. Bei Duplikaten: behalte nur den Eintrag mit der besten Datenqualität (echte produkt_url vorhanden > numerischer Preis vorhanden > vollständigerer Artikel). Gruppiere nach hersteller-Name (Groß-/Kleinschreibung ignorieren, z.B. "Wurzbacher GmbH" und "Wurzbacher" sind derselbe Lieferant).

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
      "produkt_url": "ТІЛЬКИ з переліку ECHTE, VERIFIZIERTE QUELLEN-URLS вище, інакше null",
      "vorteil": "перевага українською"
    }
  ],
  "preisanfrage_brief": "Якщо для Großhandel ціна не знайдена - офіційний лист-запит ціни німецькою мовою від L.K Bauservice (Sehr geehrte Damen und Herren, wir von L.K Bauservice...), інакше null"
}`;

    let { text: jsonText } = await callGemini(formatPrompt, false, true);
    jsonText = jsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const j1 = jsonText.indexOf('{'), j2 = jsonText.lastIndexOf('}');
    if (j1 >= 0 && j2 >= 0) jsonText = jsonText.slice(j1, j2 + 1);

    jsonText = sanitizeJson(jsonText);
    return res.status(200).json({ text: jsonText });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
