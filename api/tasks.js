// api/tasks.js
// Shared task storage synced across devices via a JSON file in this same GitHub repo.
// The GitHub token lives ONLY here (server-side env var), never exposed to the browser.
// GET  -> returns the current task list
// POST -> receives the full updated task list and writes it back to GitHub

export const config = {
  maxDuration: 30,
};

const REPO = 'andreymurga19-glitch/lk-einkauf';
const FILE_PATH = 'data/tasks.json';
const GITHUB_API = `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`;

export default async function handler(req, res) {
  try {
    return await mainHandler(req, res);
  } catch (outerErr) {
    console.error('OUTER HANDLER CRASH (tasks):', outerErr?.stack || outerErr);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'outer_crash: ' + (outerErr?.message || String(outerErr)),
      });
    }
  }
}

async function mainHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  const ghHeaders = {
    Authorization: `token ${GITHUB_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
  };

  if (req.method === 'GET') {
    const r = await fetch(GITHUB_API, { headers: ghHeaders });
    if (r.status === 404) {
      return res.status(200).json({ tasks: [] });
    }
    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: data.message || 'GitHub read error' });
    const content = Buffer.from(data.content, 'base64').toString('utf-8');
    let tasks;
    try {
      tasks = JSON.parse(content);
    } catch {
      tasks = [];
    }
    return res.status(200).json({ tasks });
  }

  if (req.method === 'POST') {
    const { tasks } = req.body || {};
    if (!Array.isArray(tasks)) return res.status(400).json({ error: 'Body must contain a "tasks" array' });

    // Fetch the current SHA right before writing, to avoid 409 conflicts
    const getR = await fetch(GITHUB_API, { headers: ghHeaders });
    let sha = null;
    if (getR.status === 200) {
      const getData = await getR.json();
      sha = getData.sha;
    }

    const newContentB64 = Buffer.from(JSON.stringify(tasks, null, 2), 'utf-8').toString('base64');
    const putBody = {
      message: 'Update tasks via lk-einkauf app',
      content: newContentB64,
    };
    if (sha) putBody.sha = sha;

    const putR = await fetch(GITHUB_API, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify(putBody),
    });
    const putData = await putR.json();
    if (!putR.ok) {
      console.error('GitHub write error:', putData);
      return res.status(500).json({ error: putData.message || 'GitHub write error' });
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
