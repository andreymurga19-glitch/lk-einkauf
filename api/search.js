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
    const sources = [];
    for (const c of (data.candidates || [])) {
      for (const p of (c.content?.parts || [])) {
        if (p.text) text += p.text;
      }
      // Extract real URLs from grounding metadata (actual search result links)
      const chunks = c.groundingMetadata?.groundingChunks || [];
      for (const chunk of chunks) {
        if (chunk.web?.uri) {
          sources.push({ title: chunk.web.title || '', uri: chunk.web.uri });
        }
      }
    }
    return { text, sources };
  }

  // ANDRII'S FIXED PROCUREMENT PROMPT - DO NOT MODIFY
  const PROCUREMENT_SYSTEM_PROMPT = `Ти — професійний асистент із закупівель для німецької будівельної компанії "L.K Bauservice". Твоє завдання — аналізувати артикули з нашої номенклатури 1С, розуміти їхнє точне призначення та технічні характеристики, а також знаходити найкращі джерела постачання в Німеччині.

АЛГОРИТМ АНАЛІЗУ ТОВАРУ (КРОК ЗА КРОКОМ):
1. Визначення призначення: Проаналізуй позицію (наприклад, "MegaGrund 353" -> грунтовка/фарба для стін 3-го класу стирання / Nassabriebklasse 3; "Валик поролоновий 110мм" -> поролоновий валик для фарбування дверей лаком).
2. Звірка з каталогом LWS/EGLWS: Перевір, які бренди чи класи якості прописані для соціального житла (наприклад, Brillux).
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

ОБОВ'ЯЗКОВІ ОКРЕМІ ПОШУКОВІ ЗАПИТИ ДЛЯ КОЖНОЇ КАТЕГОРІЇ:
Ти зобов'язаний виконати МІНІМУМ по одному окремому google_search запиту для КОЖНОЇ з 3 категорій вище — це означає МІНІМУМ 3 окремих пошуки на кожен товар, незалежно від того, наскільки "очевидним" здається результат:
- Пошук №1: товар + назва Großhandel (наприклад "Schlau Großhandel Tapetenkleister")
- Пошук №2: товар + назва конкретного Baumarkt (наприклад "Hornbach Tapetenkleister 25kg" або "Bauhaus Tapetenkleister")
- Пошук №3: товар + "Amazon" або назва онлайн-магазину
НЕ пропускай категорію Baumarkt лише тому що товар "професійний" — Hornbach/Bauhaus/OBI продають більшість будматеріалів, включно з клеями, грунтовками, інструментом. Якщо після реального пошуку в Baumarkt справді нічого не знайдено — напиши в ai_tip explicit: "У Baumarkt цей товар не знайдено", але сам пошук ОБОВ'ЯЗКОВИЙ.

ВИНЯТОК — "KEINE BAUMARKTARTIKEL" ДЛЯ МАЛЯРНИХ МАТЕРІАЛІВ (LEG-Qualitätshandbuch Gewerk Malerarbeiten, Chart 70-72):
Для наступних трьох категорій Baumarkt-артикули КАТЕГОРИЧНО ЗАБОРОНЕНІ стандартом LEG ("Keine Baumarktartikel!"):
- Dispersionsfarbe Wand/Decke (фарба для стін/стелі): дозволені бренди — Brillux, Relius, Sto, Caparol, Herbol, MEGA та інший фаховий Großhandel. Вимога: Nassabriebklasse 3, wasserdampfdiffusionsfähig (паропроникна), weiß, matt.
- Raufasertapete (шпалери-рауфазер): дозволені бренди — Erfurt & Sohn, Brillux, Conpart, MEGA. Конкретні моделі-еталони: Raufaser 52 PRO (Erfurt), Raufaser grob 51 (Brillux), Raufaser 1052 (Conpart), MEGA grob.
- Lack для дерева/металу (Holz-/Metalloberflächen): дозволені бренди — Brillux, Sto, Caparol, Sikkens, Relius, MEGA. Вимога: RAL 9010 reinweiß, seidenglänzend.
Для ЦИХ ТРЬОХ категорій: ПРОПУСТИ пошук №2 в Baumarkt (Hornbach/Bauhaus/Globus) повністю. Замість нього виконай 2-й пошук серед спеціалізованих онлайн-магазинів фарб (напр. farbenhit.de, wohntrends-shop.com, або сайт відповідного бренду напряму). У групі результатів "Baumarkt" для цих товарів напиши явно: "Заборонено LEG-стандартом (Keine Baumarktartikel) для категорії Nassabriebklasse 3 / Raufaser / Lack соц. житла".

ДОВІДНИК LEG-СТАНДАРТІВ ЯКОСТІ (Qualitätshandbuch Leerwohnungssanierung v6.0):
Якщо аналізований товар відповідає одній з категорій нижче — порівняй поточну позицію 1С з еталоном LEG. Якщо поточна позиція ВЖЕ відповідає еталону (той самий бренд/модель) — зазнач це в ai_tip і шукай тільки актуальну ціну. Якщо НЕ відповідає — у "Реальний пошук" зазнач "За LEG-стандартом для цієї категорії передбачено [бренд/модель]" і додай цей бренд як постачальника Großhandel у пошук.

01 Sanitär/Heizung:
- Trinkwasserleitungen/Verbundrohr: Uponor, Viega Sanifix Fosta, Viega Raxofix, TECEflex, WAVIN, CONEL, Fränkische alpex
- Badewanne: VIGOUR one ONS160/ONS17070 (стандарт), альт. Kaldewei Saniform Plus (Schneideverfahren)
- Duschwanne: VIGOUR clivia CLS80SF/CLS90SF/CLS9075SF (65мм); бар'єрна clivia CLS9075EF/CLS90EF (35мм)
- Duschboden: Vigour individual 2.0 або Wedi Fundo Primo; з ринвою — Vigour individual 3.0 + Cosima
- Ab-/Überlaufgarnitur, Eckventile: TRINNITY (AGD, TREV, TRWAS15)
- Wannen-/Brause-/Waschtischarmatur: VIGOUR one (ONW/ONB/ON); Brausegarnitur individual 1.0
- WC (stehend/wandhängend): VIGOUR one (ONWC/ONWWC); Spülkasten Comfort V2SP2MN
- Vorwand-Module WT/WC: CONEL VIS (CVISWT112 / CVISWCT112C, BH1120 або BH820)
- Handtuchhalter/-haken/Papierhalter: VIGOUR one (Basic/Elegant), VIGOUR clivia/derby (Comfort)
- Brausevorhangstangen: GC (VSWOR90/VSOR200)
- Handtuchheizkörper: COSMO Standard-M (CLSM); Heizkörper: COSMO Profil Kompakt Typ10-33; Thermostatkopf: COSMO CTN
- Gas-Durchlauferhitzer: Vaillant atmoMAG 18-21kW
- Wasserzähler-Unterteil: Allmess Montageblock
- Absperrventil UP: Grohe Costa

03 Malerarbeiten: див. розділ "ВИНЯТОК KEINE BAUMARKTARTIKEL" вище.

04 Fliesenarbeiten:
- Wandfliesen 30x60 weiß glänzend: BAUEN UND LEBEN bauline style BASE (Art. 6210101713) АБО Raab Karcher BasicOne Ice ME (Art. 1176881)
- Bodenfliesen 30x60 anthrazit R10/B: bauline style BASE (Art. 6220204523) АБО Raab Karcher Kermos Semento ME (Art. 1245003)
- Duschboden-Mosaik 10x10 anthrazit: Agrob Buchtal Emotion Tiefanthrazit
- Eckschienen: Schlüter-JOLLY weiß
- Abdichtung: DIN 18534 — стіни W1-I, підлога W2-I

06 Tischler/Beschlag:
- Innenfensterbank: Werzalit exklusiv 001 weiss
- Innentür: PRÜM Zimmertür glatt Lack weiß (Bad: Einlage Röhrenspan)
- Wohnungseingangstür: PRÜM glatt Weißlack, Vollspan, Klimaklasse III, Schallschutz I
- Türschließer: DORMA TS90 impulse
- Drückergarnitur: PRÜM FUTURA BB (innen) / FUTURA WC BASIC (Bad)
- Sicherheitsbeschlag: PRÜM FUTURA Langschild Edelstahl matt

07 Bodenbeläge:
- PVC/CV: MEGA eG Hamburg — Elast 35 Style / Elast 25 Top / Hit Bonita / Hit Bravo
- Vinyl-Planken: MEGA Creation 30 (1219x184x2mm)
- Laminat: MEGA BasicLine Clic it! (1292x193x7mm) АБО EGGER через Raab Karcher/Stark — EHL046 Dunino, EHL014 Kurimo, EBL006 Achensee, EHL189 Toscolano
- PVC-Sockelleiste: Döllken S60 flex life TOP / EP60-13

08 Elektroarbeiten:
- Schalterprogramm UP: Busch Jaeger Reflex SI/SI linear, alpinweiß glänzend; AP/Keller: Busch Jaeger Ocean
- Standards: VDE 0100/0105, RAL-RG678, DIN 18015
- Durchlauferhitzer: Stiebel Eltron DHB 21 ST; Niederdruckspeicher: Stiebel Eltron SNU 5 SL
- FI-Schutzschalter 2P: ABB FF202AC-40/0.3; 4P: ABB F204A-25/0.3
- Sicherungsautomat 16A: ABB SU200M-1P-C-16A
- Überspannungsschutz Typ2: ABB OVR T2 / DEHN DEHNguard modular
- Unterverteilung: Striebel+John Verteiler UP 4-reihig
- Wärmespeicherheizung: Stiebel Eltron ETS 200/400/500/600 plus

ОБОВ'ЯЗКОВИЙ ФОРМАТ ЗВІТУВАННЯ ПРО ЗНАЙДЕНІ ТОВАРИ:
Для КОЖНОГО знайденого товару/ціни у своїй текстовій відповіді ти МАЄШ написати окремий рядок у форматі:
URL: <повна точна адреса сторінки, яку ти бачив у результатах пошуку>
Цей рядок пиши ОДРАЗУ після опису товару (назва, ціна, артикул). Якщо для конкретного товару ти НЕ маєш точної адреси сторінки зі свого пошуку — напиши "URL: keine" для цього товару (НЕ пропускай рядок, НЕ вигадуй адресу).
ЦЕ КРИТИЧНО: тільки ТАКИМ способом точна URL-адреса потрапляє у фінальний результат — інакше посилання буде null.

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

    // Build a list of VERIFIED real URLs found during the actual search (deduplicated)
    const seenUris = new Set();
    let sourcesList = '';
    for (const s of sources) {
      if (seenUris.has(s.uri)) continue;
      seenUris.add(s.uri);
      sourcesList += `- ${s.title} : ${s.uri}\n`;
    }
    if (!sourcesList) sourcesList = '(Keine verifizierten Quellen-URLs gefunden)';

    // Step 2: Format search results as JSON matching the required output structure
    const formatPrompt = `Du hast folgende Recherche-Ergebnisse:

${searchResults}

ZUSÄTZLICHE QUELLEN-HINWEISE (Grounding, optional):
${sourcesList}

Erstelle jetzt NUR ein JSON-Objekt basierend auf diesen Ergebnissen, gemäß folgender Struktur (alle Texte auf Ukrainisch, außer Briefvorlage auf Deutsch):
Kein Text vor oder nach dem JSON. Nur das JSON-Objekt.

WICHTIG ZU produkt_url (PRIMÄRE QUELLE): Im Recherche-Text oben steht direkt nach jedem gefundenen Produkt eine Zeile "URL: <adresse>" oder "URL: keine". Für jedes Produkt in lieferanten MUSST du genau die zugehörige URL-Zeile finden und produkt_url EXAKT (Zeichen für Zeichen) aus dieser Zeile kopieren. Wenn die Zeile "URL: keine" lautet, setze produkt_url auf null. NIEMALS eine URL erfinden, ergänzen, kürzen oder "korrigieren" - exakte Kopie oder null, keine dritte Option. Die Liste "ZUSÄTZLICHE QUELLEN-HINWEISE" ist nur ein Hilfsmittel falls eine "URL:"-Zeile fehlt, aber NICHT der primäre Weg.

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
