// Allow more time for: Step1 search + parallel redirect resolution + Step2 formatting.
// Hobby plan caps this at 10s by default (sometimes effectively even less) which is why
// the function could be killed mid-flight by Vercel before our own catch{} could respond.
export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  // OUTER safety net: catches synchronous errors too (e.g. malformed req.body),
  // not just errors thrown inside the inner try/catch below. Without this,
  // an early crash never reaches our JSON error response and the client sees
  // Vercel's raw HTML/text error page instead, which breaks JSON.parse() on the frontend.
  try {
    return await mainHandler(req, res);
  } catch (outerErr) {
    console.error('OUTER HANDLER CRASH:', outerErr?.stack || outerErr);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'outer_crash: ' + (outerErr?.message || String(outerErr)),
        stack: outerErr?.stack || null,
      });
    }
  }
}

async function mainHandler(req, res) {
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
      const timeoutId = setTimeout(() => controller.abort(), 2500);
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

  // Hard overall deadline for resolving ALL redirects together, regardless of how many
  // chunks there are or how slow individual ones are. Protects total function duration.
  async function resolveAllWithDeadline(chunksToResolve, deadlineMs) {
    const resolvePromise = Promise.all(
      chunksToResolve.map(async (c) => ({ title: c.title, uri: await resolveRedirect(c.redirectUri) }))
    );
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve([]), deadlineMs));
    const result = await Promise.race([resolvePromise, timeoutPromise]);
    return result;
  }

  async function callGemini(prompt, useSearch, jsonMode, timeoutMs = 20000) {
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timeoutId);
      if (e.name === 'AbortError') {
        throw new Error(`Gemini-Anfrage hat das Zeitlimit von ${timeoutMs}ms überschritten`);
      }
      throw e;
    }
    clearTimeout(timeoutId);
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

    // Resolve all redirect URIs to their real destination in parallel.
    // Cap the number resolved to avoid runaway latency if Google returns many chunks,
    // AND enforce a hard overall deadline so a few slow/hanging requests can't blow the budget.
    const MAX_CHUNKS_TO_RESOLVE = 15;
    const chunksToResolve = rawChunks.slice(0, MAX_CHUNKS_TO_RESOLVE);
    const resolved = await resolveAllWithDeadline(chunksToResolve, 5000);
    const sources = resolved.filter((s) => s.uri);

    return { text, sources };
  }

  // ANDRII'S FIXED PROCUREMENT PROMPT - shared rules used by all 3 parallel category searches below
  const LWS_CATEGORY_RULES = `Ти — професійний асистент із закупівель для німецької будівельної компанії "L.K Bauservice". Твоє завдання — аналізувати артикули з нашої номенклатури 1С, розуміти їхнє точне призначення та технічні характеристики, а також знаходити найкращі джерела постачання в Німеччині.

КРИТИЧНО — ТИП ВИМОГИ LWS (визнач ПЕРШИМ кроком, ще до пошуку):
У полі "LWS-Anforderung" в даних товару міститься префікс, що ОДНОЗНАЧНО визначає тип вимоги до бренду. Розпізнай префікс і застосуй ВІДПОВІДНУ логіку пошуку нижче — це найважливіше рішення в усьому алгоритмі, воно визначає всю подальшу стратегію:

▶ [КАТ.1 — Без вимоги] — бренд НЕ важливий, єдиний критерій — ЦІНА.
  - НЕ шукай і НЕ згадуй жоден конкретний бренд як вимогу.
  - Шукай ідентичний або максимально схожий товар (за призначенням, розміром, технічними характеристиками) у будь-якого постачальника і обирай найдешевший варіант.
  - В ai_tip явно зазнач: "Бренд не регламентований LWS — орієнтуйся на найкращу ціну."
  - НЕ застосовуй обмеження "KEINE BAUMARKTARTIKEL" для цієї категорії, якщо явно не вказано інше.

▶ [КАТ.2 — Клас/стандарт LWS] — вимога до КЛАСУ/СТАНДАРТУ, а НЕ до одного бренду. У тексті вимоги перелічені 2+ рівноцінних виробники (наприклад "Brillux/Herbol/Relius/Sto/Caparol/MEGA" або "Schomburg/Botament/Ardex/PCI/MAPEI/RYWA").
  - Твоє завдання — знайти товари ВІД РІЗНИХ ВИРОБНИКІВ зі списку, що відповідають вказаному класу/параметру (напр. Nassabriebklasse 3, RAL 9010, Fugenfarbe silbergrau/anthrazit).
  - НЕ обирай довільний бренд поза переліком вимоги, якщо в самій вимозі явно не сказано "або еквівалент" без обмеження списку.
  - Якщо вимога містить позначку "KEINE BAUMARKTARTIKEL" — категорично НЕ шукай у Hornbach/Bauhaus/OBI/Globus для цього товару.

▶ [КАТ.3 — Закритий бренд LWS] — вимога до ОДНОГО конкретного бренду/моделі (наприклад VIGOUR One, TRINNITY, PRÜM, Cosmo, Busch Jaeger Reflex SI, MEGA BasicLine).
  - Шукай ТІЛЬКИ цей бренд/модель, БЕЗ альтернативних брендів.
  - Якщо в lws_req є позначка "⚠️ інший бренд, не в стандарті LWS" — це означає що ПОТОЧНА позиція 1С сама є відхиленням від еталону. У такому разі: (а) знайди ціну на ТОЧНО ТОЙ САМИЙ товар що в 1С (поточний бренд), і (б) додатково зазнач в ai_tip який бренд є справжнім еталоном LWS згідно вимоги.
  - Якщо позначка "✅ Відповідає стандарту LWS" — товар вже відповідає еталону, шукай тільки актуальну ціну цього самого бренду/моделі.

Якщо поле "LWS-Anforderung" відсутнє або не містить жодного з префіксів [КАТ.1/2/3] — трактуй товар як категорію 1 (без вимоги, орієнтир на ціну).

Регіональний фокус: Зальцгіттер (Salzgitter, індекс 38226), Брауншвайг (Braunschweig), Нижня Саксонія.

СУВОРІ ПРАВИЛА ПРОТИ ГАЛЮЦИНАЦІЙ:
- Категорично заборонено вигадувати артикули або ціни.
- Якщо для товару не знайдено точного артикула, не рекомендуй цю позицію.
- Для кожного знайденого товару вкажи: точну назву магазину/виробника, точний артикул, ціну (якщо публічно доступна) або позначку що ціна закрита логіном, і короткий опис де саме на сайті ти це бачив (щоб система потім могла зіставити з реальним посиланням).`;

  const GROSSHANDEL_PROMPT = `${LWS_CATEGORY_RULES}

ЗАВДАННЯ: Знайти товар ВИКЛЮЧНО серед Großhandel (оптових постачальників/виробників), РЕЛЕВАНТНИХ для категорії цього товару:
- Фарби/шпалери/малярні матеріали: MEGA eG, Brillux, Schlau Großhandel
- Електрика/кабель/освітлення: Sonepar, Rexel, F&G Elektro-Großhandel, Elektro Hennig, Schäcke
- Сантехніка/опалення: Richter+Frenzel, GC-Gruppe, Brink
- Будматеріали/гіпсокартон/деревина: Stark, Raab Karcher, Bauking

КРИТИЧНО — ТІЛЬКИ ОФІЦІЙНИЙ САЙТ ВИРОБНИКА/ГРОСХАНДЕЛА, БЕЗ ПЕРЕКУПНИКІВ: шукай товар ВИКЛЮЧНО на офіційному сайті самого виробника або офіційного гросхандела (напр. brillux.de, caparol.de, mega-eg.de, relius.de, richter-frenzel.de) — НЕ на сторонніх маркетплейсах чи перекупниках (Designbodenshop, dein-traumzimmer, Outtec24, Wurzbacher як онлайн-перепродавець тощо). Якщо точний релевантний Großhandel не знайдено реальним пошуком — НЕ вигадуй назву, краще напиши що не знайдено.
Спробуй пошук виду "[назва товару] site:brillux.de" або "[назва товару] site:mega-eg.de" для прямого попадання на сторінку товару.
Якщо ціна закрита логіном — це нормально, познач явно "ціна закрита логіном" і все ще надай посилання на сторінку товару/категорії на сайті виробника.
Якщо для категорії товару LWS-вимога є [КАТ.2] (клас/стандарт з кількома рівноцінними брендами) — постарайся знайти МІНІМУМ 2-3 РІЗНІ бренди з переліку вимоги, кожен окремо.

---
${'{{USER_MSG}}'}`;

  const BAUMARKT_PROMPT = `${LWS_CATEGORY_RULES}

ЗАВДАННЯ: Знайти товар ВИКЛЮЧНО серед німецьких Baumarkt: Hornbach, Globus Baumarkt, Bauhaus, OBI, Hagebau, Toom.
КРИТИЧНО — використовуй оператор site: для прямого попадання на сторінку товару: формулюй запит у вигляді "[точна назва товару] site:hornbach.de OR site:obi.de OR site:bauhaus.info OR site:hagebau.de OR site:globus-baumarkt.de". Якщо це не дало результату — спробуй ще раз з site: лише для одного магазину і простішим, коротшим формулюванням назви товару.
"ВСЕ АБО НІЧОГО": якщо знайшов артикул, але НЕ зміг знайти ЧИСЛОВУ ЦІНУ на тій же сторінці — НЕ включай цей товар у відповідь взагалі. Baumarkt-сайти публічні без логіну, тому статус "ціну потрібно уточнити" для них НЕДОПУСТИМИЙ — або є артикул+ціна разом, або нічого.
Якщо товар має позначку "KEINE BAUMARKTARTIKEL" в LWS-Anforderung (категорія 2) — напиши explicitly що Baumarkt пропущено за вимогою LWS, не шукай взагалі.
Для типових масових товарів (кабелі, кріплення, наждачний папір, фурнітура) — якщо перший запит не дав результату, спробуй ще раз з іншим формулюванням перед тим як визнати що товару немає.

---
${'{{USER_MSG}}'}`;

  const ONLINE_PROMPT = `${LWS_CATEGORY_RULES}

ЗАВДАННЯ: Знайти товар серед топ онлайн-магазинів та Amazon.de, включно з перекупниками/маркетплейсами що перепродають товари Großhandel-виробників (Designbodenshop, dein-traumzimmer, Outtec24 тощо) — для цієї категорії перекупники цілком доречні.
Для кожного знайденого товару обов'язково вкажи артикул, ціну та де саме на сайті ти це бачив.

---
${'{{USER_MSG}}'}`;


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

    const t0 = Date.now();
    // AI tab - Step 1 is now split into 3 PARALLEL category-specific searches
    // (Großhandel / Baumarkt / Online) instead of one giant sequential prompt.
    // Each is shorter and focused, so each finishes faster, and running them
    // with Promise.all means total wall-clock time ≈ the slowest single one,
    // not the sum of all three — this is what actually fixes the 504 timeouts.
    const grossPrompt = GROSSHANDEL_PROMPT.replace('{{USER_MSG}}', userMsg);
    const baumarktPrompt = BAUMARKT_PROMPT.replace('{{USER_MSG}}', userMsg);
    const onlinePrompt = ONLINE_PROMPT.replace('{{USER_MSG}}', userMsg);

    const [grossResult, baumarktResult, onlineResult] = await Promise.all([
      callGemini(grossPrompt, true, false, 25000).catch((e) => ({ text: `(Großhandel-Suche fehlgeschlagen: ${e.message})`, sources: [] })),
      callGemini(baumarktPrompt, true, false, 25000).catch((e) => ({ text: `(Baumarkt-Suche fehlgeschlagen: ${e.message})`, sources: [] })),
      callGemini(onlinePrompt, true, false, 25000).catch((e) => ({ text: `(Online-Suche fehlgeschlagen: ${e.message})`, sources: [] })),
    ]);
    console.log(`[search] Step1 (3 parallel) done in ${Date.now() - t0}ms`);

    const searchResults = `=== GROßHANDEL ===\n${grossResult.text}\n\n=== BAUMARKT ===\n${baumarktResult.text}\n\n=== ONLINE/AMAZON ===\n${onlineResult.text}`;
    const sources = [...grossResult.sources, ...baumarktResult.sources, ...onlineResult.sources];

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
    console.log(`[search] unique sources: ${uniqueSources.length}`);

    // Step 2: Format search results as JSON matching the required output structure
    const formatPrompt = `Du hast folgende Recherche-Ergebnisse:

${searchResults}

ECHTE, VERIFIZIERTE QUELLEN-URLS (das sind die EINZIGEN URLs, die du verwenden darfst):
${sourcesList}

Erstelle jetzt NUR ein JSON-Objekt basierend auf diesen Ergebnissen, gemäß folgender Struktur (alle Texte auf Ukrainisch, außer Briefvorlage auf Deutsch):
Kein Text vor oder nach dem JSON. Nur das JSON-Objekt.

KRITISCH — KEINE WIEDERVERKÄUFER ALS "Großhandel":
Wenn im Recherche-Text ein Eintrag als "Großhandel" bezeichnet wird, aber der Domain-Name/Shop-Name NICHT der offizielle Hersteller selbst oder ein bekannter Fach-Großhändler ist (z.B. Designbodenshop, dein-traumzimmer, Outtec24, Wurzbacher als Online-Wiederverkäufer, oder jeder andere generische Online-Shop, der Markenprodukte weiterverkauft) — setze für diesen Eintrag kategoriya="Online/Amazon", NICHT "Großhandel", unabhängig davon wie der Recherche-Text ihn labelt. "Großhandel" ist NUR für: den offiziellen Hersteller selbst (z.B. brillux.de, caparol.de, mega-eg.de) ODER einen anerkannten Fach-Großhändler mit physischen Niederlassungen (z.B. Richter+Frenzel, Sonepar, Stark, Raab Karcher, Bauking, Schlau). Bei Unsicherheit: wenn der Preis im Recherche-Text auffällig höher ist als bei anderen Quellen für dasselbe Produkt, ist es wahrscheinlich ein Wiederverkäufer -> "Online/Amazon".

KRITISCH ZU produkt_url — "ALLES ODER NICHTS":
Der Recherche-Text oben kann Zeilen "URL: <adresse>" enthalten — IGNORIERE DIESE ZEILEN VOLLSTÄNDIG, sie sind oft vom Modell erfunden/rekonstruiert und führen zu 404-Fehlern. Die EINZIGE gültige Quelle für produkt_url ist die Liste "ECHTE, VERIFIZIERTE QUELLEN-URLS" oben — das sind echte URLs, die durch tatsächliches Auflösen von Suchergebnis-Links gewonnen wurden.
Für jedes Produkt in lieferanten:
1. Suche in der Liste "ECHTE, VERIFIZIERTE QUELLEN-URLS" nach einem Eintrag, dessen Domain/Titel zum Hersteller/Shop dieses Produkts passt (z.B. wenn hersteller="Hornbach", suche einen Eintrag mit domain "hornbach.de").
2. Wenn ein passender Eintrag existiert: kopiere die "echte URL" EXAKT (Zeichen für Zeichen) als produkt_url.
3. Wenn KEIN passender Eintrag in der Liste existiert: ENTFERNE diesen Lieferanten KOMPLETT aus dem lieferanten-Array — füge ihn gar nicht erst hinzu. Setze NIEMALS produkt_url auf eine generische Such-/Kategorie-/Startseiten-URL und NIEMALS auf null innerhalb eines lieferanten-Eintrags — ein Eintrag ohne echte produkt-spezifische URL wird komplett weggelassen, nicht mit einem Platzhalter-Link gefüllt. Besser weniger Lieferanten im Ergebnis, aber jeder mit einem echten direkten Link zur Produktseite.
WICHTIGER HINWEIS für Großhandel-Einträge mit Status "Ціну потрібно уточнити" (Preis hinter Login): diese DÜRFEN ohne produkt_url-Übereinstimmung bleiben (das ist die einzige Ausnahme von der Regel oben) — hier reicht eine echte URL zur Hersteller-Domain aus der Liste, falls vorhanden, sonst lass produkt_url auf null NUR für diesen Spezialfall (Großhandel mit Login-geschütztem Preis).

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

    const t1 = Date.now();
    let { text: jsonText } = await callGemini(formatPrompt, false, true, 10000);
    console.log(`[search] Step2 done in ${Date.now() - t1}ms, total: ${Date.now() - t0}ms`);
    jsonText = jsonText.replace(/```json/gi, '').replace(/```/g, '').trim();
    const j1 = jsonText.indexOf('{'), j2 = jsonText.lastIndexOf('}');
    if (j1 >= 0 && j2 >= 0) jsonText = jsonText.slice(j1, j2 + 1);

    jsonText = sanitizeJson(jsonText);
    return res.status(200).json({ text: jsonText, _debug: { sourcesFound: uniqueSources.length, totalMs: Date.now() - t0 } });

  } catch (err) {
    console.error('INNER HANDLER ERROR:', err?.stack || err);
    return res.status(500).json({
      error: err?.message || String(err),
      stack: err?.stack || null,
    });
  }
}
