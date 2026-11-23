// web.js — Nio WebUI: complete server with llama.cpp backend
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync, createReadStream, accessSync, unlinkSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from './agent.js';
import { SessionStore } from './sessions.js';
import { UserProfile } from './user-memory.js';
const MAX_SEND_BODY_BYTES = 6 * 1024 * 1024; // ~6 MB text-send cap (Nio is text-only)

const __dirname = fileURLToPath(new URL('.', import.meta.url));

let config;
try {
  config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf8'));
} catch {
  console.error('No config.json found.');
  process.exit(1);
}

let backend = null;

async function getBackend() {
  if (!backend) {
    try {
      const module = await import('./llama-backend.js');
      backend = new module.LlamaBackend(config, { dataDir: DATA_DIR, modelsDir: join(DATA_DIR, 'models') });
    } catch (err) {
      console.error('[web] Failed to load llama-backend:', err.message);
    }
  }
  return backend;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let port = Number(process.env.WEB_PORT) || 8791; // match the launchers + README (8791, not ismini's 8787)
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      const val = Number(args[++i]);
      if (val < 1 || val > 65535) throw new Error(`Invalid port: ${val}`);
      port = val;
    } else if (/^\d+$/.test(args[i])) {
      const val = Number(args[i]);
      if (val < 1 || val > 65535) throw new Error(`Invalid port: ${val}`);
      port = val;
    }
  }
  return port;
}

const PORT = parseArgs();
const HOST = '127.0.0.1';

class WebUI {
  constructor(broadcast) { this.broadcast = broadcast; }
  showWarning(text) { this.broadcast({ type: 'warn', text: String(text) }); }
  showError(text) { this.broadcast({ type: 'error', text: String(text) }); }
  showModelMessage(text) { this.broadcast({ type: 'model', text: String(text) }); }
  showToolOutput(name, result) { this.broadcast({ type: 'tool', name: String(name), result: String(result) }); }
  _c(color, text) { return text; }
}

const clients = new Set();
const broadcast = (evt) => {
  const payload = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of clients) {
    try {
      if (res.writableLength > 1024 * 1024) { res.destroy(); clients.delete(res); continue; }
      const ok = res.write(payload);
      if (!ok) res.once('drain', () => {});
    } catch { clients.delete(res); }
  }
};

const AUTO_EXIT = process.env.NIO_NO_AUTOEXIT !== '1';
const SHUTDOWN_GRACE_MS = 5000;
let shutdownTimer = null;

function cancelShutdown() {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; console.log('client returned — staying alive'); }
}

let busy = false; // true while Nio is mid-turn — also blocks the auto-exit below

function scheduleShutdown(reason) {
  if (!AUTO_EXIT || shutdownTimer || clients.size > 0) return;
  if (busy) return;
  console.log(`last client gone (${reason}) — exiting in ${SHUTDOWN_GRACE_MS / 1000}s`);
  shutdownTimer = setTimeout(async () => {
    shutdownTimer = null;
    if (busy) return;
    console.log('no clients — shutting down');
    const b = await getBackend();
    if (b) await b.stop();
    for (const res of clients) { try { res.end(); } catch {} }
    process.exit(0);
  }, SHUTDOWN_GRACE_MS);
}

function resolveDataDir() {
  const candidates = [];
  if (process.env.NIO_HOME) candidates.push(process.env.NIO_HOME);
  try { candidates.push(join(homedir(), 'Nio')); } catch {}
  candidates.push(__dirname);
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(join(dir, 'sessions.json'))) return dir;
      accessSync(dir, fsConstants.W_OK);
      return dir;
    } catch {}
  }
  return __dirname;
}

const DATA_DIR = resolveDataDir();

if (DATA_DIR !== __dirname && existsSync(join(__dirname, 'sessions.json'))) {
  try { renameSync(join(__dirname, 'sessions.json'), join(DATA_DIR, 'sessions.json')); } catch {}
}

const LOG_FILE = join(DATA_DIR, 'nio.log');
try {
  const stats = statSync(LOG_FILE);
  if (stats.size > 10 * 1024 * 1024) renameSync(LOG_FILE, LOG_FILE + '.old');
} catch {}

const ui = new WebUI(broadcast);
const sessions = new SessionStore(DATA_DIR);
// Nio's durable, human-readable profile of the user (memory.md). Survives a
// session reset; read at the start of every session so Nio "knows" them.
const userProfile = new UserProfile(DATA_DIR);

function isDisplayableMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (!['user', 'assistant', 'tool'].includes(m.role)) return false;
  if (m.internal === true) return false;
  return true;
}

function visibleMessages(messages) {
  return Array.isArray(messages) ? messages.filter(isDisplayableMessage) : [];
}

function getAgentConfig() {
  return { baseUrl: `http://localhost:${config.llamaCpp?.port || 8080}`, apiKey: '' };
}

// Nio's character lives in system-prompt.md (app code, replaced on every install —
// same pattern as ismini). Read it from the file; fall back to a minimal default
// if the file is missing so Nio still boots.
function resolveSystemPrompt() {
  try {
    const content = readFileSync(join(__dirname, 'system-prompt.md'), 'utf8').trim();
    if (content) return content;
  } catch {}
  return 'You are Nio, a warm, gentle, 100% local AI friend.';
}

const agentConfig = getAgentConfig();
const agent = new Agent({
  baseUrl: agentConfig.baseUrl,
  apiKey: agentConfig.apiKey,
  modelId: '',
  systemPrompt: resolveSystemPrompt() + userProfile.toSystemPromptBlock(),
  timeoutSeconds: config.agent?.timeoutSeconds || 3600,
  contextWindow: config.agent?.contextWindow || 16384,
  temperature: config.agent?.temperature,
  maxTurns: config.agent?.maxTurns,
  maxTokens: config.agent?.maxTokens,
  enabledTools: config.tools?.enabled || ['read', 'web_search', 'web_fetch', 'memory_note'],
  userProfile,
  ui: ui,
});

async function detectModel() {
  try {
    const r = await fetch(`http://localhost:${config.llamaCpp?.port || 8080}/v1/models`, { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    return j?.data?.[0]?.id || null;
  } catch { return null; }
}

async function detectLoadedModel() {
  try {
    const resp = await fetch(`http://localhost:${config.llamaCpp?.port || 8080}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json();
    const m = (data.data || [])[0];
    if (!m) return null;
    // The context is whatever the user set in config (manual, no auto-detection).
    const ctx = config.llamaCpp?.context || 16384;
    return { id: m.id, context: ctx, tools: true };
  } catch { return null; }
}

function applyLoadedModel(agent, det, cfg) {
  const ctx = det?.context || cfg.agent?.contextWindow || 16384;
  const cfgMax = cfg.agent?.maxTokens || 8192;
  const max = Math.max(256, Math.min(cfgMax, ctx - 1024));
  agent.contextWindow = ctx;
  agent.maxTokens = max;
  agent.loadedModel = det;
  if (det?.id) agent.modelId = det.id;
  return { ctx, max };
}

try {
  const det = await detectLoadedModel();
  if (det) { applyLoadedModel(agent, det, config); console.log(`model → ${det.id}`); }
} catch {}

// ── The nudge (Nio's signature move) ────────────────────────────────
// If the user goes quiet mid-conversation, Nio taps their shoulder ONCE:
// a short, warm line on his own initiative ("hey where u lost"). Rules:
// one nudge per silence, never after a goodbye, only while a tab is open
// and the model is ready. The system prompt teaches the *style*; this
// timer is plain engineering.
const NUDGE_IDLE_MS = (Number(config.agent?.nudgeIdleMinutes) || 5) * 60 * 1000;
let lastUserMessageAt = Date.now();
let nudgePending = false;
let nudgedSinceLastUserMsg = false; // one nudge per silence — no double-texting

const GOODBYE_RE = /\b(bye|goodbye|see (you|ya) (later|tomorrow)|good ?night|cya|g2g|im (off|out|going) now|i should go|have to go|got to go|me afw)\b/i;

function conversationIsOpen() {
  const msgs = visibleMessages(agent.messages);
  if (msgs.length < 2) return false; // nothing real happened yet — no tap on the shoulder
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  if (!lastUser || typeof lastUser.content !== 'string') return false;
  if (GOODBYE_RE.test(lastUser.content)) return false; // user left the room — a friend doesn't tap after that
  const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
  return Boolean(lastAssistant); // mid-conversation: Nio answered and is waiting for the other side
}

function maybeNudge() {
  if (busy || nudgePending || nudgedSinceLastUserMsg) return;
  if (clients.size === 0) return; // no one watching — don't burn tokens into the void
  if (Date.now() - lastUserMessageAt < NUDGE_IDLE_MS) return;
  if (!conversationIsOpen()) return;
  const b = backend;
  if (!b || b.state !== 'ready') return;
  nudgePending = true;
  nudgedSinceLastUserMsg = true; // the one-and-only — even if this turn fails, we don't retry
  console.log('[nio] user has been quiet a while — nudging once');
  runTurn(
    '[NUDGE — your own initiative, not a reply to anything] The user has gone quiet for a few minutes in the middle of our conversation. Tap their shoulder ONCE: one short, warm line (1-2 sentences max), playful, zero guilt-tripping, ideally tied to what we were just talking about. If you have nothing useful to add, just say you are still here. Do not ask them to confirm anything or start a new topic.',
    { internal: true }
  ).catch(err => console.error('[nio] nudge turn failed:', err?.message || err));
}

setInterval(maybeNudge, 30 * 1000).unref();

const rawActiveSession = sessions.getActive();
const activeMessages = visibleMessages(rawActiveSession?.messages || []);
if (rawActiveSession) {
  agent.loadMessages(activeMessages);
  sessions.saveActive(activeMessages);
  console.log(`session → restored (${activeMessages.length} messages)`);
} else {
  sessions.create();
  console.log('session → new');
}

async function runTurn(text, opts = {}) {
  busy = true;
  try {
    const det = await detectLoadedModel();
    const prevId = agent.loadedModel?.id;
    applyLoadedModel(agent, det, config);
    if (det && det.id !== prevId) broadcast({ type: 'modelSwitch', id: det.id });
  } catch {}

  const orig = process.stdout.write;
  process.stdout.write = (chunk, encoding, callback) => {
    const enc = typeof encoding === 'string' ? encoding : 'utf8';
    const cb = typeof encoding === 'function' ? encoding : callback;
    const s = Buffer.isBuffer(chunk) ? chunk.toString(enc) : String(chunk);
    const t = s.trim();
    if (t && !/^─+$/.test(t)) {
      // Tag lines ([turn], [llama], [web]…) are excluded; plain prose passes
      // through untouched — including lowercase-starting words (the old filter
      // looked like it also ate those, but the on-disk regex never did).
      if (!/^\[(turn|data|nio|llama|web)\]/.test(t) && !/^(model|session|last client|no clients|client returned)/.test(t) && !/^bye!/.test(t)) {
        broadcast({ type: 'token', text: s });
      }
    }
    if (typeof callback === 'function') callback();
    else if (typeof cb === 'function') cb();
    return true;
  };

  let paused = false;
  const turnStart = Date.now();
  try {
    // Nudge turns pass an internal note: pushed as a hidden user-role message
    // (never shown in the UI, never saved to sessions — isDisplayableMessage()
    // filters it out) so the model sees it as "the user went quiet" context.
    if (opts?.internal) agent._push('user', text, { internal: true });
    await agent.run(text);
    console.log(`[turn] ok in ${((Date.now() - turnStart) / 1000).toFixed(1)}s`);
  } catch (err) {
    if (err.name === 'AbortError') { paused = true; broadcast({ type: 'paused' }); }
    else { console.error(`[turn] FAILED:\n${err?.stack || err}`); broadcast({ type: 'error', text: err?.message || String(err) }); }
  } finally {
    process.stdout.write = orig;
    busy = false;
    sessions.saveActive(visibleMessages(agent.messages));
    if (!paused) broadcast({ type: 'done', messages: visibleMessages(agent.messages).length });
    if (clients.size === 0) scheduleShutdown('turn finished');
  }
}

const SECURITY_HEADERS = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let tooLarge = false;
    req.on('data', (d) => { if (tooLarge) return; size += d.length; if (size > limit) { tooLarge = true; req.destroy(); const error = new Error('request body is too large'); error.statusCode = 413; reject(error); return; } chunks.push(d); });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function isLocalOrigin(origin) {
  try {
    const url = new URL(origin);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return (url.protocol === 'http:' || url.protocol === 'https:') && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && port === String(PORT);
  } catch { return false; }
}

let INDEX_HTML = readFileSync(join(__dirname, 'web', 'index.html'), 'utf8');
INDEX_HTML = INDEX_HTML.replace(
  /(<style[^>]*>)/i,
  `$1\nhtml,body{height:100dvh!important;max-height:100dvh!important}`
);

const LIVE_TTS_MODULE = readFileSync(join(__dirname, 'web', 'live-tts.js'), 'utf8');

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const fetchSite = req.headers['sec-fetch-site'];
  if ((origin && !isLocalOrigin(origin)) || (!origin && fetchSite === 'cross-site')) return sendJson(res, 403, { error: 'cross-origin requests are not allowed' });

  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return sendJson(res, 400, { error: 'bad url' }); }

  try {
    cancelShutdown();

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' });
      res.end(INDEX_HTML);
    }
    else if (req.method === 'GET' && url.pathname === '/live-tts.js') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(LIVE_TTS_MODULE);
    }
    else if (req.method === 'GET' && url.pathname === '/nio.png') {
      // Nio's one icon (the transparent master). Used as the page favicon and the
      // manifest icon — a single source for everywhere Nio needs an icon.
      const path = join(__dirname, 'nio.png');
      try { statSync(path); } catch { return sendJson(res, 404, { error: 'no icon' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000' });
      createReadStream(path).pipe(res);
    }
    else if (req.method === 'GET' && url.pathname === '/nio-avatar.png') {
      // In-chat avatar (Nio's face, transparent, crisp). Served long-lived.
      // This is NOT a title-bar favicon — see the note at the route registration.
      const path = join(__dirname, 'web', 'nio-avatar.png');
      try { statSync(path); } catch { return sendJson(res, 404, { error: 'no avatar' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000' });
      createReadStream(path).pipe(res);
    }
    else if (req.method === 'GET' && (url.pathname === '/nio.gif' || url.pathname === '/welcome.gif')) {
      // Welcome-screen animated GIFs (Nio sprite + welcome banner).
      const path = join(__dirname, 'web', url.pathname.replace(/^\//, ''));
      try { statSync(path); } catch { return sendJson(res, 404, { error: 'no gif' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/gif', 'cache-control': 'public, max-age=31536000' });
      createReadStream(path).pipe(res);
    }
    else if (req.method === 'GET' && url.pathname === '/manifest.webmanifest') {
      const path = join(__dirname, 'web', 'manifest.webmanifest');
      try { const buf = readFileSync(path); res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache', 'content-length': buf.length }); res.end(buf); }
      catch { return sendJson(res, 404, { error: 'no manifest' }); }
    }
    else if (req.method === 'GET' && url.pathname === '/blue.jpg') {
      const path = join(__dirname, 'web', 'blue.jpg');
      try { statSync(path); } catch { return sendJson(res, 404, { error: 'no blue' }); }
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'image/jpeg', 'cache-control': 'no-cache' });
      createReadStream(path).pipe(res);
    }
    else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'connection': 'keep-alive' });
      res.write('retry: 2000\n\n');
      clients.add(res);
      cancelShutdown();
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 15000);
      res.on('close', () => { clearInterval(ping); clients.delete(res); scheduleShutdown('tab closed'); });
      const model = await detectModel();
      const b0 = await getBackend();
      const backendInfo = b0 ? { state: b0.state, model: b0.currentModel } : { state: 'error', model: null };
      try { res.write(`data: ${JSON.stringify({ type: 'hello', model, busy, messages: visibleMessages(agent.messages).length, contextWindow: agent.contextWindow, backend: backendInfo })}\n\n`); } catch {}
    }
    else if (req.method === 'POST' && url.pathname === '/send') {
      if (busy) return sendJson(res, 409, { error: 'agent busy' });
      const b = await getBackend();
      if (!b || b.state !== 'ready') {
        const msg = !b ? 'Nio’s model engine could not start.' : b.state === 'starting' ? 'Nio’s model is still loading. ⏳' : 'Nio’s model engine stopped.';
        return sendJson(res, 409, { error: msg });
      }
      const body = await readBody(req, MAX_SEND_BODY_BYTES);
      let payload;
      try { payload = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'expected JSON' }); }
      const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
      if (!text) return sendJson(res, 400, { error: 'enter a message' });
      sendJson(res, 202, { ok: true });
      lastUserMessageAt = Date.now(); // user is back — cancel any pending nudge
      runTurn(text);
    }
    else if (req.method === 'POST' && url.pathname === '/pause') {
      if (!busy) return sendJson(res, 409, { error: 'agent not running' });
      agent.pause();
      sendJson(res, 200, { ok: true });
    }

    else if (req.method === 'POST' && url.pathname === '/new') {
      if (busy) return sendJson(res, 409, { error: 'agent busy' });
      // Nio: one session at a time, always fresh — replace (don't archive) the old one.
      const newSession = sessions.resetToNew();
      agent.reset();
      // Refresh the profile block: memory_note may have written new facts to
      // memory.md (or the user edited it by hand) since startup, and the
      // baked-in prompt is stale after a reset. refresh() re-reads from disk.
      agent._fullSystemPrompt = resolveSystemPrompt() + userProfile.refresh();
      broadcast({ type: 'reset', sessionId: newSession.id });
      sendJson(res, 200, { ok: true, sessionId: newSession.id });
    }
    else if (req.method === 'GET' && url.pathname === '/api/window-size') {
      const ws = config.windowSize;
      const ok = ws && Number.isInteger(ws.width) && Number.isInteger(ws.height) && ws.width >= 200 && ws.height >= 150;
      sendJson(res, 200, ok ? { width: ws.width, height: ws.height } : {});
    }
    else if (req.method === 'POST' && url.pathname === '/api/window-size') {
      const body = await readBody(req);
      let parsed;
      try { parsed = JSON.parse(body); } catch { return sendJson(res, 400, { error: 'expected { width: int, height: int }' }); }
      const width = Math.round(Number(parsed.width));
      const height = Math.round(Number(parsed.height));
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || width > 8000 || height < 150 || height > 8000) {
        return sendJson(res, 400, { error: 'expected integer width (200-8000) and height (150-8000)' });
      }
      config.windowSize = { width, height };
      let saved = true;
      try { writeFileSync(join(__dirname, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8'); } catch { saved = false; }
      sendJson(res, saved ? 200 : 500, saved ? { ok: true, width, height } : { error: 'could not save window size' });
    }
    else if (req.method === 'GET' && url.pathname === '/api/context') {
      // Report the configured context length and what the backend is actually using.
      let activeCtx = null;
      try { const b = await getBackend(); activeCtx = b?.status?.()?.context || null; } catch {}
      const cfg = Number(config.llamaCpp?.context);
      sendJson(res, 200, {
        active: activeCtx || null,
        configured: Number.isFinite(cfg) && cfg > 0 ? cfg : 16384,
      });
    }
    else if (req.method === 'POST' && url.pathname === '/api/context') {
      const body = await readBody(req);
      let value;
      try { value = JSON.parse(body).value; } catch { return sendJson(res, 400, { error: 'expected { value: int }' }); }
      if (busy) return sendJson(res, 409, { error: 'Nio is busy — try again in a moment' });
      const b = await getBackend();
      if (!b) return sendJson(res, 503, { error: 'backend not available' });
      const v = Math.round(Number(value));
      if (!Number.isInteger(v) || v < 4096 || v > 262144) return sendJson(res, 400, { error: 'context must be an integer 4096–262144' });
      config.llamaCpp = config.llamaCpp || {};
      config.llamaCpp.context = v;
      config.agent = config.agent || {};
      config.agent.contextWindow = v;
      try { writeFileSync(join(__dirname, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf8'); } catch {}
      // Restart the backend so the new -c takes effect (KV cache is allocated at
      // llama-server startup, so a context change requires a restart).
      broadcast({ type: 'toast', msg: 'Applying context length… (reloading model)' });
      const ok = await b.switchModel(b.currentModel);
      if (!ok) return sendJson(res, 500, { error: 'Could not restart the model — context change not applied' });
      const det = await detectLoadedModel();
      applyLoadedModel(agent, det, config);
      broadcast({ type: 'toast', msg: `Context length set to ${v.toLocaleString()} tokens` });
      sendJson(res, 200, { ok: true, active: v, value: v });
    }
    else if (req.method === 'GET' && url.pathname === '/state') {
      const model = await detectModel();
      sendJson(res, 200, { busy, model, messages: visibleMessages(agent.messages).length, contextWindow: agent.contextWindow, maxTokens: agent.maxTokens, sessionId: sessions.getActive()?.id || null });
    }
    else if (req.method === 'GET' && url.pathname === '/transcript') {
      const s = sessions.getActive();
      const msgs = s ? visibleMessages(s.messages) : [];
      sendJson(res, 200, { messages: msgs, busy, sessionId: s?.id || null });
    }
    else if (req.method === 'GET' && url.pathname === '/api/backend') {
      const b = await getBackend();
      sendJson(res, 200, b ? b.status() : { state: 'error', models: [] });
    }
    else {
      sendJson(res, 404, { error: 'not found' });
    }
  } catch (err) {
    try { sendJson(res, err?.statusCode || 500, { error: err?.message || String(err) }); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Nio → http://${HOST}:${PORT}`);
  console.log(`model endpoint → http://localhost:${config.llamaCpp?.port || 8080}`);
});

{
  const b = await getBackend();
  if (b) {
    b.onStateChange = (state, extra = {}) => {
      console.log(`[web] backend → ${state}${extra.model ? ' (' + extra.model + ')' : ''}`);
      broadcast({ type: 'backend', state, model: extra.model || b.currentModel || null });
    };
    b.start().then(ok => { if (ok) console.log('[web] llama.cpp backend is up'); else console.log('[web] no model yet'); }).catch(err => console.error('[web] backend start failed:', err.message));
  }
}

process.on('unhandledRejection', (err) => { console.error('[nio] unhandled rejection:', err?.stack || err); });
// Stop the llama-server child on exit — otherwise it survives the web server
// and keeps holding the model in RAM (and port 8091). SIGINT = Ctrl-C;
// SIGTERM = what install.sh's stop_running_app sends before replacing files.
let shuttingDown = false;
async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nbye!');
  for (const res of clients) { try { res.end(); } catch {} }
  const b = await getBackend();
  if (b) await b.stop().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
// The nio launcher writes ~/Nio/server.pid for this process. The auto-exit
// path (last tab closed) used to leave it behind — a STALE PID FILE IS THE
// NORMAL STATE, and after a reboot the number can belong to an unrelated
// process. Remove it on every exit so a leftover pid file never points at us.
function removeLauncherPidFile() {
  try {
    const f = join(DATA_DIR, 'server.pid');
    if (existsSync(f)) {
      const p = parseInt(readFileSync(f, 'utf8').trim(), 10);
      if (p === process.pid) unlinkSync(f);
    }
  } catch {}
}
process.on('exit', removeLauncherPidFile);
server.on('error', (err) => { if (err.code === 'EADDRINUSE') { console.error(`Port ${PORT} is already in use.`); process.exit(1); } throw err; });