// Doom-Timer backend: Node.js built-in http server + built-in SQLite (no npm install needed).
// Requires Node.js 22.13 or newer.  Run:  node server.js   then open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- Database: one file, one table ----
const db = new DatabaseSync(path.join(__dirname, 'doomtimer.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    distraction TEXT NOT NULL,
    wage        REAL NOT NULL,
    currency    TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    cost        REAL NOT NULL
  )
`);

const insertSession = db.prepare(
  'INSERT INTO sessions (distraction, wage, currency, duration_ms, cost) VALUES (?, ?, ?, ?, ?)'
);

// ---- Helpers ----
function sendJSON(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10000) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(new Error('Invalid JSON')); }
    });
  });
}

function totals(where) {
  return db.prepare(
    `SELECT COUNT(*) AS sessions, COALESCE(SUM(duration_ms),0) AS ms, COALESCE(SUM(cost),0) AS cost
     FROM sessions WHERE ${where}`
  ).get();
}

// ---- API routes ----
async function handleApi(req, res) {
  // Save a finished session
  if (req.method === 'POST' && req.url === '/api/sessions') {
    try {
      const b = await readBody(req);
      const distraction = String(b.distraction || '').slice(0, 60).trim();
      const currency = String(b.currency || '').slice(0, 3).toUpperCase();
      const wage = Number(b.wage);
      const durationMs = Math.round(Number(b.durationMs));
      if (!distraction || !currency || !(wage > 0) || !(durationMs > 0) || !isFinite(wage) || !isFinite(durationMs)) {
        return sendJSON(res, 400, { error: 'Invalid session data' });
      }
      // The server calculates the cost itself, so the stored value can't be faked by the client.
      const cost = (durationMs / 3600000) * wage;
      insertSession.run(distraction, wage, currency, durationMs, cost);
      return sendJSON(res, 201, { ok: true, cost });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
  }

  // Summary + recent sessions
  if (req.method === 'GET' && req.url === '/api/history') {
    return sendJSON(res, 200, {
      today: totals("date(created_at) = date('now','localtime')"),
      week: totals("date(created_at) >= date('now','localtime','-6 days')"),
      recent: db.prepare(
        'SELECT created_at, distraction, currency, duration_ms, cost FROM sessions ORDER BY id DESC LIMIT 10'
      ).all()
    });
  }

  // Clear all saved sessions
  if (req.method === 'DELETE' && req.url === '/api/sessions') {
    db.exec('DELETE FROM sessions');
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 404, { error: 'Not found' });
}

// ---- Static files (the web page) ----
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) handleApi(req, res);
  else serveStatic(req, res);
}).listen(PORT, () => console.log(`Doom-Timer running at http://localhost:${PORT}`));
