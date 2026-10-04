'use strict';
/* ABHYNEX JARVIS backend (Groq + Claude) - zero dependencies (Node 18+). All secrets stay here. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
/* Locate the folder that holds index.html (normally ./public; also tolerates a flat upload). */
const PUBLIC_CANDIDATES = [path.join(__dirname, 'public'), path.join(__dirname, 'Public'), path.join(process.cwd(), 'public'), __dirname];
function findPublic() {
  for (const d of PUBLIC_CANDIDATES) if (fs.existsSync(path.join(d, 'index.html'))) return d;
  return null;
}
let PUBLIC = findPublic();
console.log('Static folder:', PUBLIC || 'NOT FOUND (index.html is missing from the deployment)');
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const GROQ_MODEL = (process.env.GROQ_MODEL || '').trim() || 'llama-3.3-70b-versatile';
const CLAUDE_MODEL = (process.env.CLAUDE_MODEL || '').trim() || 'claude-haiku-4-5-20251001';
const AI_PROVIDER = (process.env.AI_PROVIDER || 'auto').trim().toLowerCase(); // auto | groq | claude
const APP_PASSCODE = process.env.APP_PASSCODE || '';
const SEARCH_KEY = process.env.SEARCH_API_KEY || '';
const UNAVAILABLE = 'JARVIS is temporarily unavailable. Please try again.';
const NO_SEARCH = 'Live web search is currently unavailable. I can still answer from my own knowledge.';
const LIMITS = { message: 2000, history: 20, histItem: 4000, memory: 10, memItem: 300 };

for (const m of [GROQ_MODEL, CLAUDE_MODEL]) if (!/^[\w.\-:]+$/.test(m)) { console.error('Invalid model name in environment'); process.exit(1); }
if (!GROQ_KEY && !ANTHROPIC_KEY) console.warn('Warning: set GROQ_API_KEY and/or ANTHROPIC_API_KEY - chat will be unavailable.');
if (!APP_PASSCODE) console.warn('Warning: APP_PASSCODE is not set - login will be disabled.');
console.log('AI providers:', providerOrder().join(' -> ') || 'none');

/* ---------- auth (signed, expiring session token; passcode never leaves server) ---------- */
const SECRET = crypto.createHash('sha256').update('jarvis-session:' + APP_PASSCODE).digest();
const b64 = (b) => Buffer.from(b).toString('base64url');
function sign(ttlMs) {
  const p = b64(JSON.stringify({ exp: Date.now() + ttlMs }));
  return p + '.' + crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
}
function verify(token) {
  try {
    const [p, s] = String(token || '').split('.');
    const good = crypto.createHmac('sha256', SECRET).update(p).digest('base64url');
    const a = Buffer.from(s || ''), b = Buffer.from(good);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now();
  } catch { return false; }
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
const attempts = new Map(); // ip -> {n, t}
function throttled(ip) {
  const now = Date.now(), r = attempts.get(ip);
  if (!r || now - r.t > 15 * 60 * 1000) return false;
  return r.n >= 8;
}
function noteFail(ip) {
  const now = Date.now(), r = attempts.get(ip);
  if (!r || now - r.t > 15 * 60 * 1000) attempts.set(ip, { n: 1, t: now }); else r.n++;
}
const hits = new Map(); // simple per-token chat rate limit
function rateOk(key) {
  const now = Date.now(), r = hits.get(key) || [];
  const recent = r.filter((t) => now - t < 60000);
  recent.push(now); hits.set(key, recent);
  return recent.length <= 30;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of attempts) if (n - v.t > 900000) attempts.delete(k); hits.clear(); }, 600000).unref();

/* ---------- helpers ---------- */
function send(res, code, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra));
  res.end(body);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const authed = (req) => verify((req.headers.authorization || '').replace(/^Bearer /i, ''));

/* ---------- live search (provider adapter; real results only) ---------- */
const searchProviders = {
  // Brave Search API. To add another provider, add an adapter here returning [{title,url,snippet}].
  async brave(query) {
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?count=5&q=' + encodeURIComponent(query), {
      headers: { 'X-Subscription-Token': SEARCH_KEY, Accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) throw new Error('search status ' + r.status);
    const j = await r.json();
    return ((j.web && j.web.results) || []).slice(0, 5).map((x) => ({ title: x.title, url: x.url, snippet: x.description }));
  },
};
const searchAvailable = () => Boolean(SEARCH_KEY);
async function liveSearch(query) {
  if (!searchAvailable()) return null;
  return searchProviders.brave(query);
}

/* ---------- AI providers: Groq + Claude ---------- */
function systemPrompt(lang, clientTime, tz, memory, results) {
  const langName = { 'en-IN': 'English', 'hi-IN': 'Hindi', 'mr-IN': 'Marathi' }[lang] || 'the user\'s language';
  let s = 'You are JARVIS, the voice assistant inside the ABHYNEX JARVIS mobile web app. ' +
    'Be warm, sharp and concise: replies are often read aloud, so use short natural sentences, no markdown symbols, no emojis. ' +
    'Reply in the language the user writes or speaks in (preferred language: ' + langName + '). ' +
    'You run in a web browser: you cannot call, text, set alarms, change phone settings or open apps. If asked, say so plainly and suggest what the user can do manually. ' +
    'You have no live data unless search results are provided below; never invent news, prices, scores or sources.';
  if (clientTime) s += ' The user\'s device date and time is: ' + clientTime + (tz ? ' (' + tz + ')' : '') + '.';
  if (memory.length) s += '\nThings the user asked you to remember:\n- ' + memory.join('\n- ');
  if (results && results.length) {
    s += '\nLive web search results (cite the site names, do not fabricate beyond these):\n' +
      results.map((r, i) => (i + 1) + '. ' + r.title + ' - ' + r.snippet + ' (' + r.url + ')').join('\n');
  }
  return s;
}
function toChat(history, message) {
  // alternate roles, start with user, merge consecutive same-role turns (required by Claude)
  const out = [];
  for (const m of history.concat([{ role: 'user', text: message }])) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    if (!out.length && role !== 'user') continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += '\n' + m.text;
    else out.push({ role, content: m.text });
  }
  return out;
}
const providers = {
  async groq(system, msgs) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_KEY },
      body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.7, max_tokens: 1024, messages: [{ role: 'system', content: system }].concat(msgs) }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) { const e = new Error('groq status ' + r.status); e.status = 'groq ' + r.status; throw e; }
    const j = await r.json();
    return String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
  },
  async claude(system, msgs) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, system, messages: msgs }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) { const e = new Error('claude status ' + r.status); e.status = 'claude ' + r.status; throw e; }
    const j = await r.json();
    return ((j.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('')).trim();
  },
};
function providerOrder() {
  const have = { groq: !!GROQ_KEY, claude: !!ANTHROPIC_KEY };
  const order = AI_PROVIDER === 'claude' ? ['claude', 'groq'] : ['groq', 'claude']; // auto: Groq first (fast), Claude as backup
  return order.filter((p) => have[p]);
}
async function askAI(system, history, message) {
  const msgs = toChat(history, message);
  let lastErr;
  for (const p of providerOrder()) {
    try { return await providers[p](system, msgs); } catch (e) { lastErr = e; console.error('Provider failed:', e.status || e.name); }
  }
  throw lastErr || new Error('no provider configured');
}

/* ---------- API routes ---------- */
async function api(req, res, url) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  try {
    if (req.method === 'POST' && url === '/api/login') {
      if (!APP_PASSCODE) return send(res, 503, { success: false, error: 'Login is not configured.' });
      if (throttled(ip)) return send(res, 429, { success: false, error: 'Too many attempts. Try again later.' });
      const body = await readJson(req);
      const code = str(body.passcode, 200);
      if (!code || !safeEqual(code, APP_PASSCODE)) { noteFail(ip); return send(res, 401, { success: false, error: 'Incorrect passcode.' }); }
      return send(res, 200, { success: true, token: sign(12 * 3600 * 1000) });
    }
    if (req.method === 'GET' && url === '/api/session') {
      if (!authed(req)) return send(res, 401, { success: false });
      return send(res, 200, { success: true, search: searchAvailable() });
    }
    if (req.method === 'POST' && url === '/api/chat') {
      if (!authed(req)) return send(res, 401, { success: false, error: 'Session expired. Enter your passcode again.' });
      if (!rateOk(req.headers.authorization || ip)) return send(res, 429, { success: false, reply: 'Slow down a little and try again in a minute.' });
      const body = await readJson(req);
      const message = str(body.message, LIMITS.message + 1);
      if (!message) return send(res, 400, { success: false, reply: 'Please type or say something.' });
      if (message.length > LIMITS.message) return send(res, 400, { success: false, reply: 'That message is too long. Please keep it under ' + LIMITS.message + ' characters.' });
      const history = (Array.isArray(body.conversation) ? body.conversation : []).slice(-LIMITS.history)
        .map((m) => ({ role: m && m.role === 'assistant' ? 'assistant' : 'user', text: str(m && m.text, LIMITS.histItem) }))
        .filter((m) => m.text);
      const memory = (Array.isArray(body.memory) ? body.memory : []).slice(-LIMITS.memory).map((m) => str(m, LIMITS.memItem)).filter(Boolean);
      let results = null;
      if (body.search === true) {
        try { results = await liveSearch(message); } catch (e) { console.error('Search failed:', e.message); results = null; }
        if (!results) return send(res, 200, { success: true, reply: NO_SEARCH, searchUnavailable: true });
      }
      if (!providerOrder().length) return send(res, 503, { success: false, reply: UNAVAILABLE });
      const system = systemPrompt(str(body.language, 10), str(body.clientTime, 80), str(body.timeZone, 60), memory, results);
      const reply = await askAI(system, history, message);
      return send(res, 200, { success: true, reply: reply || 'I could not come up with an answer to that. Could you rephrase?' });
    }
    return send(res, 404, { success: false, error: 'Not found.' });
  } catch (e) {
    console.error('API error:', e.status ? 'upstream ' + e.status : e.name + ': ' + e.message); // never log keys/stacks
    return send(res, 502, { success: false, reply: UNAVAILABLE, error: UNAVAILABLE });
  }
}

/* ---------- static files ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SEC = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'",
};
const PRIVATE = /(^|\/)(\.|node_modules|server\.js$|package(-lock)?\.json$|render\.yaml$|readme)/i;
function serveStatic(req, res, pathname) {
  PUBLIC = PUBLIC || findPublic();
  if (!PUBLIC) {
    res.writeHead(500, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, SEC));
    return res.end('ABHYNEX JARVIS is running, but index.html was not found in the deployment. Make sure the "public" folder is uploaded next to server.js.');
  }
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html';
  let file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || (PUBLIC === __dirname && PRIVATE.test(rel))) { res.writeHead(403, SEC); return res.end('Forbidden'); }
  fs.stat(file, (err0, st0) => {
    let err = err0, st = st0;
    if ((err || !st.isFile()) && rel.startsWith('/icons/')) { // flat uploads: icons may sit next to index.html
      const alt = path.join(PUBLIC, path.basename(rel));
      if (fs.existsSync(alt)) { file = alt; err = null; st = fs.statSync(alt); }
    }
    if (err || !st.isFile()) {
      if (path.extname(rel)) { res.writeHead(404, SEC); return res.end('Not found'); }
      file = path.join(PUBLIC, 'index.html'); // SPA fallback
    }
    const ext = path.extname(file);
    const noCache = file.endsWith('service-worker.js') || file.endsWith('index.html');
    const stream = fs.createReadStream(file);
    stream.on('error', () => { if (!res.headersSent) res.writeHead(500, SEC); res.end('Server error'); });
    stream.on('open', () => {
      res.writeHead(200, Object.assign({ 'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600' }, SEC));
      if (req.method === 'HEAD') { stream.destroy(); return res.end(); }
      stream.pipe(res);
    });
  });
}

const server = http.createServer((req, res) => {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === '/healthz') return send(res, 200, { status: 'ok' });
  if (pathname.startsWith('/api/')) return api(req, res, pathname);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  try { serveStatic(req, res, pathname); } catch { res.writeHead(400); res.end('Bad request'); }
});
server.listen(PORT, '0.0.0.0', () => console.log('ABHYNEX JARVIS listening on port ' + PORT));
