// agent.js — Core agent loop: prompt → llama.cpp → tools → repeat
// Zero dependencies beyond Node.js built-ins.
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, isAbsolute, extname, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { fetch as webFetch } from './tools/web-fetch.js';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ── Inactivity timeout for streaming model calls ────────────────────────
const MODEL_INACTIVITY_TIMEOUT_MS = 120000; // 2 min of silence → give up

function raceWithInactivity(promise, { abort } = {}) {
  let timer;
  let settled = false;
  let resolve, reject;
  const clear = () => clearTimeout(timer);
  const settle = (fn, val) => { if (!settled) { settled = true; clear(); fn(val); } };
  const reset = () => {
    clear();
    timer = setTimeout(() => {
      settle(reject, new Error(`Model inactivity timeout (${MODEL_INACTIVITY_TIMEOUT_MS / 1000}s with no output)`));
      if (abort) { try { abort(); } catch {} }
    }, MODEL_INACTIVITY_TIMEOUT_MS);
    if (timer.unref) timer.unref();
  };
    const promise2 = new Promise((res, rej) => {
      resolve = res; reject = rej;
      reset();
      promise.then(
        (v) => settle(resolve, v),
                   (e) => settle(reject, e)
      );
    });
    return { promise: promise2, activity: () => { if (!settled) reset(); } };
}

// ── Suppress repeated tool lists in model output ───
function stripRepeatedToolList(text, prevAssistantMsgs) {
  if (!text || !prevAssistantMsgs || prevAssistantMsgs.length < 2) return text;
  const lastTwo = prevAssistantMsgs.slice(-2).map(m => typeof m === 'string' ? m : (m.content || ''));
  const hasToolBlock = (t) => {
    return t.includes('tool_calls') || t.includes('tool_call') ||
    t.includes('function.name') || t.includes('function.arguments') ||
    (t.includes('read(') && t.includes('web_search(') && t.includes('web_fetch('));
  };
  if (!hasToolBlock(lastTwo[0]) || !hasToolBlock(lastTwo[1])) return text;
  const lines = text.split('\n');
  const strippedLines = [];
  let foundToolBlock = false;
  let inToolBlock = false;
  for (const line of lines) {
    if (/^\*\*[Tt]ools\*\*/.test(line)) {
      inToolBlock = true;
      foundToolBlock = true;
      continue;
    }
    if (line.trim().startsWith('`')) {
      if (!inToolBlock) strippedLines.push(line);
      else inToolBlock = false;
      continue;
    }
    if (inToolBlock) continue;
    strippedLines.push(line);
  }
  if (foundToolBlock) return strippedLines.join('\n').trim();
  return text;
}

// ── Model output cleanup — strip filler patterns ───
function cleanupModelOutput(text) {
  if (!text) return text;
  let cleaned = text.trim();
  const originalLen = cleaned.length;
  const LEADING_GREETINGS = [
    /^(?:hello|hi|hey)\s*[!,.]?\s+/i,
    /^(?:i'?m\s+)?nio[.,!?]?\s+/i,
  ];
  for (const pat of LEADING_GREETINGS) {
    const m = cleaned.match(pat);
    if (m && m[0].length < cleaned.length) cleaned = cleaned.replace(pat, '');
  }
  const TRAILING_FILLER = [
    /\s*[,-]?\s*how can i help( you)?[?.!?]?$/i,
    /\s[,-]?\s*what can i do for you[?.!?]?$/i,
    /\s[,-]?\s*(?:anything else|else)[?.!?]?$/i,
    /\s*[,-]?\s*let me know if you need (?:anything|more)[?.!?]?$/i,
  ];
  for (const pat of TRAILING_FILLER) {
    const before = cleaned.replace(pat, '').trim();
    const isSubstantive = before.length >= 10 && /\s/.test(before);
    if (isSubstantive && before.length < originalLen) cleaned = before;
  }
  return cleaned.trim();
}

function isToolError(name, result) {
  if (typeof result !== 'string' || !result) return false;
  // "Missing required arg" errors are the MODEL's fault (bad tool-call args),
  // not a tool failure. Do NOT count them toward the tool-fail streak —
  // otherwise the model gets a "tool has failed 3 times" note for its own
  // mistake, which confuses it and wastes a turn.
  const isMissingArg = /^Error: "[\w]+" required\b/.test(result);
  if (isMissingArg) return false;
  switch (name) {
    case 'web_search':
      return /^Search failed\b|^Web search error\b|^Error\b/.test(result);
    case 'web_fetch':
      return /^Fetch error\b|^HTTP \d{3}\b|^Error\b/.test(result);
    case 'read':
      return /^Error reading file\b/.test(result);
    default:
      return /^Error\b/.test(result);
  }
}

// ── Streaming line formatter — readable paragraph/section spacing ───
function createLineFormatter(onLine) {
  let buf = '';
  let prevLine = '';
  let prevType = 'start';
  let blankRun = 0;
  let started = false;
  let inCode = false;

  const isHead = (t) => /^#{1,6}(\s|$)/.test(t);
  const isList = (t) => /^([-*+]|\d+\.)\s/.test(t);
  const isCode = (t) => t.startsWith('`');
  const isTable = (t) => t.startsWith('|') && t.endsWith('|') && t.length > 1;

  const typeOf = (line) => {
    const t = line.trim();
    if (t === '') return 'blank';
    if (isCode(t)) return 'code';
    if (isHead(t)) return 'head';
    if (isList(t)) return 'list';
    if (isTable(t)) return 'table';
    return 'text';
  };

  const fixLine = (line, type) => {
    if (type === 'blank' || type === 'code') return line;
    let t = line;
    t = t.replace(/^([-*+])(\S)/, '$1 $2').replace(/^(\d+\.)(\S)/, '$1 $2');
    if (!t.includes('://')) {
      t = t.replace(/^([A-Za-z]{2,}[\w-]{0,30}):([^\s/:])/, '$1: $2');
      t = t.replace(/^([-*+]\s|\d+\.\s)([A-Za-z]{2,}[\w-]{0,30}):([^\s/:])/, '$1$2: $3');
    }
    return t;
  };

  const emitRaw = (line) => {
    const type = typeOf(line);
    const fixed = fixLine(line, type);
    if (!started) {
      started = true;
      if (type === 'blank') { prevType = 'blank'; blankRun = 1; return; }
      prevLine = fixed; prevType = type;
      onLine(fixed + '\n');
      return;
    }
    if (type === 'blank') {
      if (blankRun === 0) onLine('\n');
      blankRun = Math.min(blankRun + 1, 2);
      prevType = 'blank';
      return;
    }
    blankRun = 0;
    const prevContent = prevType !== 'blank';
    const headOrTable = (type === 'head' || type === 'table') && prevContent;
    const fence = type === 'code' && prevContent && prevType !== 'code';
    const listAfterText = type === 'list' && prevContent && prevType !== 'list';
    const textAfterBlock = type === 'text' && (prevType === 'list' || prevType === 'head' || prevType === 'code');
    if ((headOrTable || fence || listAfterText || textAfterBlock) && prevLine.trim() !== '') {
      onLine('\n');
    }
    prevLine = fixed;
    prevType = type;
    onLine(fixed + '\n');
  };

  const emit = (line) => {
    if (line.trim().startsWith('`')) inCode = !inCode;
    if (inCode) {
      prevLine = line; prevType = 'code'; blankRun = 0; started = true;
      onLine(line + '\n');
      return;
    }
    const m = line.match(/(\S)(#{2,6}\s)/);
    if (m) {
      emit(line.slice(0, m.index + 1));
      emit(line.slice(m.index + 1));
      return;
    }
    const m2 = line.match(/^(#{1,6}\s\S[^\n]*?)([-*+])(?=\s+\S)/);
    if (m2) {
      const marker = m2[2];
      const before = m2[1].slice(-1);
      const after = line[m2.index + m2[0].length];
      const isMarkup = (before === marker) || (after === marker);
      if (!isMarkup) {
        emit(line.slice(0, m2[1].length));
        emit(line.slice(m2[1].length));
        return;
      }
    }
    emitRaw(line);
  };

  return {
    push(chunk) {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        emit(line);
      }
    },
    flush() {
      if (buf !== '') {
        const line = buf;
        buf = '';
        emit(line);
      }
    },
  };
}

// ── Tool implementations ────────────────────────────────────────────
const SENSITIVE_PATTERNS = [
  '/.ssh/', '/.gnupg/', '/.gnome/',
'/.config/google-chrome/', '/.config/firefox/', '/.mozilla/',
'/authorized_keys', '/id_rsa', '/id_ed25519', '/known_hosts',
'/shadow', '/passwd', '/group', '/sudoers'
];

function resolveUserPath(p, workspace) {
  if (typeof p !== 'string' || !p) return null;
  let path = p.trim();
  let basePath;
  if (workspace && isAbsolute(workspace)) basePath = workspace;
  else basePath = homedir();
  if (path === '~') return homedir();
  if (path.startsWith('~/')) path = join(homedir(), path.slice(2));
  else if (path.startsWith('~\\')) path = join(homedir(), path.slice(2));
  else path = isAbsolute(path) ? path : join(basePath, path);
  const resolved = path;
  let canonical;
  try {
    if (existsSync(resolved)) canonical = realpathSync(resolved);
    else {
      const parentDir = dirname(resolved);
      const baseName = basename(resolved);
      if (existsSync(parentDir)) canonical = join(realpathSync(parentDir), baseName);
      else canonical = resolved;
    }
  } catch { return null; }
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.endsWith('/')) {
      if (canonical.includes(pattern)) return null;
    } else {
      if (canonical === pattern || canonical.endsWith(pattern) || canonical.includes(pattern + '/')) return null;
    }
  }
  if (/^\/(etc|boot|sys|proc|dev)\//.test(canonical)) return null;
    const home = homedir();
  const workspacePath = workspace && isAbsolute(workspace) ? workspace : home;
  if (!canonical.startsWith(home) && !canonical.startsWith(workspacePath)) return null;
  return canonical;
}

// Hard cap on a single tool result. Kept small on purpose: Nio targets small
// local models (often 16k context), and one giant tool result (a big file read)
// can be tens of thousands of tokens on its own — enough to overflow the whole
// context in one message. 48 KB still holds far more than any realistic answer;
// the rolling window then keeps many such results within the model's budget
// instead of one blowing it up.
const MAX_TOOL_OUTPUT = 48 * 1024;

function capToolOutput(text) {
  if (typeof text !== 'string' || text.length <= MAX_TOOL_OUTPUT) return text;
  const head = Math.floor(MAX_TOOL_OUTPUT * 0.7);
  const tail = MAX_TOOL_OUTPUT - head;
  return text.slice(0, head)
  + `\n... [truncated ${text.length - MAX_TOOL_OUTPUT} chars — output exceeded the ${MAX_TOOL_OUTPUT / 1024} KB cap] ...\n`
  + text.slice(text.length - tail);
}

async function toolRead(args, workspace) {
  const p = args.path || args.file;
  if (!p) return 'Error: "path" required.';
  try {
    const resolved = resolveUserPath(p, workspace);
    if (resolved === null) return 'Error: Access denied to this path.';
    const ext = extname(resolved).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.tiff', '.ico', '.avif'].includes(ext)) {
      return 'I can’t read image files — I work with text only. If you can describe what’s in the image, I’m happy to help with that.';
    }
    if (['.pdf', '.zip', '.gz', '.tar', '.7z', '.rar', '.exe', '.bin', '.so', '.dylib', '.dll', '.o', '.a', '.class', '.jar', '.war', '.ear', '.pyc', '.wasm', '.mp3', '.mp4', '.avi', '.mkv', '.flac', '.ogg', '.wav', '.mid', '.m4a', '.webm', '.mov', '.psd', '.ai', '.skp', '.blend', '.fig', '.xd'].includes(ext)) {
      return `This is a binary file (${ext}) and can’t be read as text. I can only read plain-text files (e.g. .txt, .md, .js, .json).`;
    }
    const content = readFileSync(resolved, 'utf8');
    const lines = content.split('\n');
    if (lines.length > 10000) {
      return capToolOutput(`File has ${lines.length} lines. Showing first 10000:\n\n${lines.slice(0, 10000).join('\n')}\n... [truncated]`);
    }
    return capToolOutput(content);
  } catch (err) { return `Error reading file: ${err.message}`; }
}


async function toolWebSearch(args) {
  let q = '';
  if (typeof args === 'string') {
    q = args;
  } else if (args && typeof args === 'object') {
    q = args.query || args.q || args.search || args.text || args.input || args.prompt || '';
    if (!q) {
      // Fall back to the first non-empty string value, whatever the key is called
      for (const v of Object.values(args)) {
        if (typeof v === 'string' && v.trim()) { q = v; break; }
      }
    }
  }
  q = (q || '').trim();
  if (!q) return 'Error: "query" required.';
  try {
    const { search } = await import('./tools/web-search.js');
    return await search(q);
  } catch (err) { return `Web search error: ${err.message}`; }
}

async function toolWebFetch(args) {
  const u = args.url || args.uri;
  if (!u) return 'Error: "url" required.';
  return await webFetch(u);
}

async function toolMemoryAdd(args, memory) {
  if (!memory) return 'Memory is unavailable.';
  const text = args.text || args.content;
  if (!text) return 'Error: "text" required.';
  try {
    const { memory: m, evicted } = memory.add(text, args.category);
    let msg = `Saved memory ${m.id}: ${m.text}`;
    if (evicted) msg += `— NOTE: memory was full (200 max), so the oldest entry was dropped: "${evicted.text}" (${evicted.id}). Mention this to the user.`;
    return msg;
  } catch (err) { return `Memory error: ${err.message}`; }
}

async function toolMemorySearch(args, memory) {
  if (!memory) return 'Memory is unavailable.';
  const q = args.query || '';
  try {
    const results = await memory.search(q, Number(args.limit) || 5);
    if (!results.length) return 'No matching memories found.';
    return results.map((m, i) => `${i + 1}. [${m.id}] ${m.text}${m.category ? ` (${m.category})` : ''}`).join('\n');
  } catch (err) { return `Memory error: ${err.message}`; }
}

// Recall: keyword-search across ALL past sessions and surface matching messages.
async function toolRecall(args, sessions) {
  if (!sessions || typeof sessions.search !== 'function') return 'Recall is unavailable (no session archive).';
  const q = args.query || args.q || '';
  if (!q || !q.trim()) return 'Error: "query" required for recall.';
  try {
    const results = sessions.search(q, Number(args.limit) || 8);
    if (!results.length) return `No past-session messages matched "${q}". Try broader keywords.`;
    const fmt = (t) => (t.length > 400 ? t.slice(0, 400) + ' …' : t);
    return results.map((r, i) => {
      const d = new Date(r.sessionDate).toISOString().slice(0, 10);
      return `${i + 1}. [${r.role} · ${d} · session ${r.sessionId.slice(0, 8)}]\n${fmt(r.text)}`;
    }).join('\n\n');
  } catch (err) { return `Recall error: ${err.message}`; }
}

async function toolMemoryDelete(args, memory) {
  if (!memory) return 'Memory is unavailable.';
  const id = args.id;
  if (!id) return 'Error: "id" required.';
  try {
    return memory.delete(id) ? `Deleted memory ${id}` : `Memory not found: ${id}`;
  } catch (err) { return `Memory error: ${err.message}`; }
}

// memory_note: record a durable fact about the USER in memory.md (the human-
// readable profile). Use when you learn something lasting — their name, where
// they live, their PC specs, family, habits, a rule they've set for you, music,
// sports, etc. This is what makes Nio remember them across every session.
async function toolMemoryNote(args, userProfile) {
  if (!userProfile) return 'Profile memory is unavailable.';
  const text = args.text || args.fact || args.content;
  if (!text || !String(text).trim()) return 'Error: "text" (the durable fact about the user) is required.';
  const action = (args.action || 'note').toLowerCase();
  try {
    if (action === 'replace') {
      const r = userProfile.replace(String(text));
      return r.ok ? 'Profile updated (full rewrite).' : `Profile error: ${r.error}`;
    }
    const r = userProfile.note(String(text));
    return r.ok
      ? `Remembered for next time: ${String(text).trim()}. (Saved to your profile, memory.md.)`
      : `Profile error: ${r.error}`;
  } catch (err) { return `Profile error: ${err.message}`; }
}

const TOOL_MAP = {
  read: toolRead,
  web_search: toolWebSearch,
  web_fetch: toolWebFetch,
  memory_add: toolMemoryAdd,
  memory_search: toolMemorySearch,
  memory_delete: toolMemoryDelete,
  memory_note: toolMemoryNote,
  recall: toolRecall,
};

// ── Tool-call text leak guard ──────────────────────────────────────
// Small models (Qwen3.5-2B) sometimes emit the tool call as plain text
// (e.g. a <tool_call> block or a web_search(...) line) instead of using
// the native tool_calls channel. That text is then shown to the user
// AND read aloud by TTS. Detect it, strip it from the visible content,
// and recover the call so the tool still runs.
const TOOL_LEAK_RE = /<tool_call>[\s\S]*?<\/tool_call>|<function=[A-Za-z0-9_]+>[\s\S]*?<\/function>|[A-Za-z0-9_]+\s*\((?:[^()]*|\([^()]*\))*\)/g;
const TOOL_LEAK_NAMES = new Set(Object.keys(TOOL_MAP));

function looksLikeToolLeak(text) {
  if (!text) return false;
  if (/<tool_call>|<function=/.test(text)) return true;
  const m = text.match(/[A-Za-z0-9_]+\s*\(/g);
  return !!(m && m.some((w) => TOOL_LEAK_NAMES.has(w.replace(/\s*\($/, ''))));
}

function stripToolLeak(text) {
  if (!text) return text;
  return String(text).replace(TOOL_LEAK_RE, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

function recoverLeakedToolCalls(text) {
  const calls = [];
  if (!text) return calls;
  const seen = new Set();
  const push = (name, args) => {
    if (!name || !TOOL_LEAK_NAMES.has(name)) return;
    const key = name + '|' + JSON.stringify(args);
    if (seen.has(key)) return;
    seen.add(key);
    calls.push({ id: `call_${name}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`, name, args, parsedArgs: args });
  };
  // <function=name> ... </function> or <tool_call><function=name>...</function></tool_call>
  for (const m of String(text).matchAll(/<function=([A-Za-z0-9_]+)>([\s\S]*?)<\/function>/g)) {
    const name = m[1];
    const body = m[2];
    const args = {};
    for (const am of body.matchAll(/<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g)) {
      args[am[1]] = am[2].trim();
    }
    push(name, args);
  }
  // Bare name(args) — args are comma-separated key="value" pairs
  for (const m of String(text).matchAll(/([A-Za-z0-9_]+)\s*\(([^()]*)\)/g)) {
    const name = m[1];
    if (!TOOL_LEAK_NAMES.has(name)) continue;
    const args = {};
    for (const am of m[2].matchAll(/([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
      args[am[1]] = am[2].replace(/\\"/g, '"');
    }
    if (!Object.keys(args).length) {
      for (const am of m[2].matchAll(/([A-Za-z0-9_]+)\s*=\s*([^,]+)/g)) {
        args[am[1]] = am[2].trim();
      }
    }
    push(name, args);
  }
  return calls;
}

// ── Tool call parser (handles both OpenAI and llama.cpp formats) ───
function parseToolCalls(message) {
  const calls = [];
  if (message.tool_calls && Array.isArray(message.tool_calls)) {
    for (const tc of message.tool_calls) {
      let fnName, fnArgs;
      if (tc.name !== undefined && tc.parsedArgs !== undefined) {
        fnName = tc.name || '';
        fnArgs = tc.parsedArgs || {};
      } else {
        try {
          fnName = tc.function?.name || '';
          fnArgs = JSON.parse(tc.function?.arguments || '{}');
        } catch { fnName = ''; fnArgs = {}; }
      }
      calls.push({ id: tc.id, name: fnName, args: fnArgs });
    }
  }
  if (message.tool && typeof message.tool === 'object') {
    const fn = message.tool.function;
    if (fn) {
      let fnName, fnArgs;
      try {
        fnName = fn.name || '';
        fnArgs = JSON.parse(fn.arguments || '{}');
      } catch { fnName = ''; fnArgs = {}; }
      calls.push({ id: message.tool.id || 'tool_0', name: fnName, args: fnArgs });
    }
  }
  if (message.function_call && typeof message.function_call === 'object') {
    const fc = message.function_call;
    let fnName, fnArgs;
    try { fnName = fc.name || ''; fnArgs = JSON.parse(fc.arguments || '{}'); } catch { fnName = ''; fnArgs = {}; }
    calls.push({ id: 'tool_fc', name: fnName, args: fnArgs });
  }
  return calls;
}

// ── Agent class ─────────────────────────────────────────────────────
export class Agent {
  constructor(opts) {
    this.baseUrl = opts.baseUrl;
    this.apiKey = opts.apiKey || '';
    this.modelId = opts.modelId;
    this.systemPrompt = opts.systemPrompt;
    this.maxTurns = opts.maxTurns;
    this.temperature = (typeof opts.temperature === 'number' && Number.isFinite(opts.temperature)) ? opts.temperature : null;
    this.timeoutSeconds = opts.timeoutSeconds || 3600;
    this.contextWindow = opts.contextWindow || 16384;
    this.maxTokens = opts.maxTokens || 8192;
    this.messages = [];
    this.workspace = opts.workspace || process.cwd();
    this.memory = opts.memory || null;
    this.userProfile = opts.userProfile || null;  // memory.md — durable user profile
    this.sessions = opts.sessions || null;
    this.ui = opts.ui;
    this._abort = null;
    this._contextDir = null;
    // The system prompt is fully defined by the user in config.json.
    this._fullSystemPrompt = this.systemPrompt || 'You are a helpful assistant.';
    this.enabledTools = opts.enabledTools || ['read', 'web_search', 'web_fetch'];
    this._enabledToolsInit = [...this.enabledTools];
    this._onToolOutput = opts.onToolOutput || (() => {});
    this._consecutiveToolTurns = 0;
    this._consecutiveEmptyTurns = 0;
    this._toolFailStreak = {};
    this._toolFailNoted = new Set();
  }

  _push(role, content, opts = {}) {
    const msg = typeof content === 'string' || Array.isArray(content) ? { role, content } : { ...content };
    if (opts.internal) msg.internal = true;
    this.messages.push(msg);
    return msg;
  }

  reset() {
    this.messages = [];
    this._consecutiveToolTurns = 0;
    this._consecutiveEmptyTurns = 0;
    this._toolFailStreak = {};
    this._toolFailNoted = new Set();
    this.enabledTools = [...this._enabledToolsInit];
  }

  loadMessages(messages) {
    this.messages = [...messages];
    this._consecutiveToolTurns = 0;
    this._consecutiveEmptyTurns = 0;
    this._toolFailStreak = {};
    this._toolFailNoted = new Set();
    this.enabledTools = [...this._enabledToolsInit];
  }

  pause() {
    if (this._abort) this._abort.abort();
  }

  async run(userMessage) {
    this.messages = this.messages.filter(m => !(m.role === 'system' && m.internal));
    this._push('user', userMessage);

    // ── CRITICAL FIX ──
    // Always create a FRESH AbortController for every turn. The old code checked
    // the previous controller's state first, so after a single Pause the aborted
    // signal poisoned every subsequent message and Nio froze for good.
    this._abort = new AbortController();

    const maxTurns = this.maxTurns || 20;
    let turnCount = 0;
    let hasFinalResponse = false;
    let consecutiveToolTurns = 0;
    const runTimeout = this.timeoutSeconds || 3600;
    const runTimer = setTimeout(() => {
      this.ui.showError(`Run timeout after ${runTimeout}s`);
      this.pause();
    }, runTimeout * 1000);

    try {
      while (turnCount < maxTurns) {
        if (this._abort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        turnCount++;

        // Work on a copy — never mutate this.messages with transient system prompts.
        // (_callLM always injects the system prompt itself.)
        const messages = this.messages.slice();
        const truncated = this._enforceContextWindow(messages, this.modelId);

        let streamedContent = '';
        const cols = process.stdout.columns || 80;
        const lineW = Math.min(cols - 6, 60);
        const line = '─'.repeat(lineW);
        process.stdout.write('\n   ' + this.ui._c('modelBorder', line) + '\n');

        let response;
        const { promise: lmPromise, activity } = raceWithInactivity(
          this._callLM(truncated, {
            stream: true,
            signal: this._abort.signal,
            onChunk: (chunk) => {
              streamedContent += chunk;
              process.stdout.write(chunk);
              activity();
            },
          }),
          { abort: () => this._abort?.abort() }
        );

        try { response = await lmPromise; }
        catch (err) {
          if (this._abort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          throw err;
        }

        if (streamedContent.trim()) process.stdout.write('\n   ' + this.ui._c('modelBorder', line) + '\n');

        if (!response || !response.choices?.[0]?.message) {
          this.ui.showError('No valid response from model.');
          break;
        }

        const msg = response.choices[0].message;
        let content = msg.content || '';
        let toolCalls = parseToolCalls(msg).map(tc => ({
          ...tc,
          id: typeof tc.id === 'string' && tc.id ? tc.id : `call_${tc.name}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
        }));

        // ── Tool-call text leak guard ──
        // The model emitted the tool call as plain text (e.g. a <tool_call>
        // block) instead of the native tool_calls channel. Strip it from the
        // visible/speaked content and recover the call so it still runs.
        if (toolCalls.length === 0 && looksLikeToolLeak(content)) {
          const recovered = recoverLeakedToolCalls(content);
          if (recovered.length) {
            toolCalls = recovered;
            content = stripToolLeak(content);
          }
        }

        if (streamedContent.trim()) process.stdout.write('\n');

        // ── No tool calls → final answer ──
        if (toolCalls.length === 0) {
          const prevAssistants = this.messages.filter(m => m.role === 'assistant');
          let cleaned = stripRepeatedToolList(content, prevAssistants);
          cleaned = cleanupModelOutput(cleaned);
          hasFinalResponse = true;

          const lastAssistant = prevAssistants[prevAssistants.length - 1];
          const lastContent = lastAssistant?.content || '';
          const cleanedTrimmed = cleaned.trim();
          const lastTrimmed = lastContent.trim();

          if (lastTrimmed && cleanedTrimmed.length > 20 && cleanedTrimmed === lastTrimmed) {
            this._push('assistant', cleaned);
            break;
          }

          if (!content.trim() && !streamedContent.trim()) {
            this._consecutiveEmptyTurns++;
            if (this._consecutiveEmptyTurns >= 2) {
              const stopMsg = '[HARD STOP] You have produced empty output twice in a row. You are stuck in a loop. End the conversation.';
              this._push('system', { role: 'system', content: stopMsg }, { internal: true });
              this.ui.showWarning('Model stuck in empty-output loop. Stopping.');
              break;
            }
            this._push('system', {
              role: 'system',
              content: '[SYSTEM NOTE] You produced empty output. This is likely because you called a tool without providing a text answer. When you call a tool, you MUST also include a brief text response to the user alongside the tool call. For example: "let me look that up" + a web_search call. Never call tools with no accompanying text.'
            }, { internal: true });
            const fallback = "I don't have anything to add right now.";
            this._push('assistant', fallback);
            this.ui.showModelMessage(fallback);
          } else {
            this._consecutiveEmptyTurns = 0;
            const finalText = (cleaned && cleaned.trim()) || (streamedContent && streamedContent.trim()) || '';
            if (finalText) {
              this._push('assistant', finalText);
              if (!streamedContent.trim()) this.ui.showModelMessage(finalText);
            }
          }
          break;
        }

        // ── Tool calls ──
        const validToolCalls = toolCalls.filter(tc => tc.name);
        if (validToolCalls.length === 0) {
          this.ui.showError('Model sent an incomplete tool call — treating it as a text answer.');
          break;
        }

        const assistantContent = content || '';
        const assistantMsg = {
          role: 'assistant',
          content: assistantContent.trim() ? assistantContent : null,
                    tool_calls: validToolCalls.map(tc => ({
                      id: tc.id,
                      type: 'function',
                      function: { name: tc.name, arguments: JSON.stringify(tc.parsedArgs && Object.keys(tc.parsedArgs).length ? tc.parsedArgs : {}) }
                    }))
        };
        this._push('assistant', assistantMsg);

        if (assistantMsg.content) consecutiveToolTurns = 0;
        else consecutiveToolTurns++;

        for (const tc of validToolCalls) {
          if (this._abort?.signal?.aborted) {
            for (const pending of validToolCalls) {
              const alreadyAnswered = this.messages.some(m => m.role === 'tool' && m.tool_call_id === pending.id);
              if (!alreadyAnswered) {
                this._push('tool', {
                  role: 'tool',
                  tool_call_id: pending.id,
                  name: pending.name,
                  content: '[Nio] paused before this step ran — no result.'
                });
              }
            }
            throw new DOMException('Aborted', 'AbortError');
          }

          const result = await this._executeTool(tc.name, tc.args);
          this.ui.showToolOutput(tc.name, result);

          if (isToolError(tc.name, result)) {
            this._toolFailStreak[tc.name] = (this._toolFailStreak[tc.name] || 0) + 1;
          } else {
            this._toolFailStreak[tc.name] = 0;
            this._toolFailNoted.delete(tc.name);
          }

          this._push('tool', { role: 'tool', tool_call_id: tc.id, name: tc.name, content: result });
        }

        // NOTE: the tool-fail note is role:'system' + internal so run() strips it
        // next turn. Do NOT use role:'user' here — a hidden user-role message at the
        // end of the array breaks llama.cpp's Jinja template ("No user query found in
        // messages.") and the rolling-window eviction can evict the REAL user question
        // in favor of this note (the cause of an earlier 500 + "I don't know what you
        // asked" bug).
        for (const [name, streak] of Object.entries(this._toolFailStreak)) {
          if (streak >= 3 && !this._toolFailNoted.has(name)) {
            this._toolFailNoted.add(name);
            this._push('system', {
              role: 'system',
              content: `[SYSTEM NOTE] The "${name}" tool has failed ${streak} times in a row (often a temporary issue like rate limiting). Stop retrying it for now and tell the user what happened. It may work again later.`
            }, { internal: true });
          }
        }

        const webCallsThisTurn = toolCalls.filter(tc => tc.name === 'web_search' || tc.name === 'web_fetch').length;
        if (webCallsThisTurn >= 3) {
          this._push('system', {
            role: 'system',
            content: '[SYSTEM] You have made several web calls this turn and have plenty of material. Give the user a direct answer now. The web tools remain available if something is genuinely missing.'
          }, { internal: true });
        }

        // ── Too many silent tool turns → force a final answer ──
        if (consecutiveToolTurns >= 3) {
          this._push('system', {
            role: 'system',
            content: '[HARD STOP] You have called tools several times without a text answer. Using ONLY the results you already have, give the user a direct final answer now. Do not call any more tools.'
          }, { internal: true });

          let finalStreamedContent = '';
          process.stdout.write('\n   ' + this.ui._c('modelBorder', line) + '\n');
          let finalResponse;
          try {
            const { promise: finalPromise, activity: finalActivity } = raceWithInactivity(
              this._callLM(this._enforceContextWindow(this.messages.slice(), this.modelId), {
                stream: true,
                noTools: true,
                signal: this._abort.signal,
                onChunk: (chunk) => { finalStreamedContent += chunk; process.stdout.write(chunk); finalActivity(); },
              }),
              { abort: () => this._abort?.abort() }
            );
            finalResponse = await finalPromise;
          } catch (err) {
            if (this._abort?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            this.ui.showError(err?.message || String(err));
          }

          const finalText = (finalResponse?.choices?.[0]?.message?.content || '').trim() || finalStreamedContent.trim();
          if (finalText) {
            this._push('assistant', finalText);
            // If tokens were already streamed to the UI (live bubble), do NOT
            // broadcast a second `model` event — that would render the answer
            // twice (live bubble + addModel). The normal path (line ~820) has
            // the same guard; this forced-final-answer path was missing it.
            if (!finalStreamedContent.trim()) this.ui.showModelMessage(finalText);
          } else {
            const fallback = 'I ran out of steps before I could finish that. Here is what I have so far from the results above.';
            this._push('assistant', fallback);
            this.ui.showModelMessage(fallback);
          }
          hasFinalResponse = true;
          break;
        }
      }

      if (!hasFinalResponse) this.ui.showWarning('Reached max turns without final response.');
    } finally {
      clearTimeout(runTimer);
    }
  }

  _enforceContextWindow(messages, modelId) {
    // Rolling window: keep the MOST RECENT turns within a safe token budget, so a
    // small model (e.g. 16k context) never overflows. We work in "turns" so an
    // assistant tool-call is never separated from its tool results (invalid).
    let charsPerToken = 4.0;
    if (modelId) {
      const id = modelId.toLowerCase();
      if (id.includes('qwen') || id.includes('llama')) charsPerToken = 3.5;
      else if (id.includes('phi')) charsPerToken = 3.8;
    }
    const sys = messages.find(m => m.role === 'system');
    const rest = (sys ? messages.filter(m => m !== sys) : messages.slice());

    const tok = (m) => {
      // Be conservative for tool results: long paths, whitespace, base64 and
      // repetitive output tokenize at < 2 chars/token, so the default estimate
      // under-counts exactly the content that overflows a small context.
      const rate = m.role === 'tool' ? Math.min(charsPerToken, 2.2) : charsPerToken;
      const chars = Array.isArray(m.content)
        ? m.content.reduce((t, p) => t + (typeof p?.text === 'string' ? p.text.length : p?.type === 'image_url' ? 4096 : 0), 0)
        : typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length;
      return Math.ceil(chars / rate) + 4;
    };
    const sysTok = sys ? tok(sys) : 0;
    // Reserve room for the reply; the history window is what remains.
    const reserve = Math.min(this.maxTokens || 8192, (this.contextWindow || 16384) - 2048);
    const budget = Math.max(1024, (this.contextWindow || 16384) - reserve) - sysTok;
    // Hard cap a single message (e.g. one giant tool result) so it can never
    // force the window over budget on its own. The model can read the full
    // output via the read tool if it truly needs more.
    const maxSingleTok = Math.max(1024, Math.floor(budget * 0.6));

    // Group into turns: a "turn" = an assistant msg (with its tool_calls) + the tool
    // results that immediately follow it; otherwise a single user/assistant msg.
    const turns = [];
    for (let i = 0; i < rest.length; i++) {
      const m = rest[i];
      if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
        const group = [m];
        let j = i + 1;
        while (j < rest.length && rest[j].role === 'tool') { group.push(rest[j]); j++; }
        turns.push(group);
        i = j - 1;
      } else {
        turns.push([m]);
      }
    }

    // Keep turns from newest to oldest until the budget is used.
    // CRITICAL: the LAST real user turn (the model's current question) must always
    // be in the window, otherwise llama.cpp's Jinja template throws
    // "No user query found in messages." and the rolling window silently evicts
    // the question when the budget is tight.
    let anchorIdx = -1;
    for (let i = rest.length - 1; i >= 0; i--) {
      if (rest[i].role === 'user') { anchorIdx = i; break; }
    }
    const anchorTurnIdx = anchorIdx >= 0
      ? turns.findIndex(g => g.includes(rest[anchorIdx]))
      : -1;

    const kept = [];
    let used = 0;
    const turnCost = (g) => g.reduce((s, m) => s + tok(m), 0);
    // Pre-check: does even the anchor (the user's latest question) alone fit the
    // budget? If not, the model's context is too small for the system prompt + a
    // single turn + a reply. We still send the anchor (the question must be present)
    // and let the window add nothing — better a short, valid request than a 400.
    const anchorFits = anchorTurnIdx >= 0 && turnCost(turns[anchorTurnIdx]) <= budget;
    for (let i = turns.length - 1; i >= 0; i--) {
      const cost = turnCost(turns[i]);
      if (i === anchorTurnIdx) {
        // The user's latest question must stay in the window — always keep it.
        kept.push(...turns[i].reverse());
        used += cost;
        continue;
      }
      // SKIP oversized turns instead of bailing. A single huge tool result must
      // not stop the walk — otherwise the window keeps only that one giant
      // turn and can send a request that's still over the model's context.
      if (tok(turns[i][0]) > maxSingleTok) continue;
      // Enforce the budget on EVERY turn (including the first kept). The previous
      // code used `kept.length > 0 &&` here, which let the FIRST kept turn slip in
      // un-budgeted — so one giant tool result (e.g. a big file read)
      // could push the request over the model's context → the 400.
      if (used + cost > budget) continue;
      kept.push(...turns[i].reverse());
      used += cost;
    }
    // Safety net: if the kept set (anchor + whatever fit) still exceeds budget —
    // e.g. the anchor itself is large — drop the largest non-anchor turns until
    // we're under budget. We never drop the anchor (the question must stay).
    while (anchorFits === false || (used > budget)) {
      // Find the largest non-anchor kept turn and remove it.
      let dropIdx = -1, dropCost = 0;
      for (let i = 0; i < kept.length; i++) {
        const m = kept[i];
        if (anchorTurnIdx >= 0 && turns[anchorTurnIdx].includes(m)) continue; // never drop the anchor
        const c = tok(m);
        if (c > dropCost) { dropCost = c; dropIdx = i; }
      }
      if (dropIdx === -1) break; // only the anchor remains — send as-is
      kept.splice(dropIdx, 1);
      used = Math.max(0, used - dropCost);
      if (used <= budget) break;
    }
    kept.reverse();
    // Fallback: if no user message was found at all (e.g. only tool results), keep
    // at least the most recent turn so the model has *something* to respond to.
    if (!kept.length && rest.length) kept.push(rest[rest.length - 1]);
    return sys ? [sys, ...kept] : kept;
  }

  async _callLM(messages, opts = {}) {
    const allTools = [
      { type: 'function', function: { name: 'read', description: 'Read file contents. Args: path (string). Returns file content as string.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'web_search', description: 'Search the web (DuckDuckGo) and get readable results. Args: query (string).', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'web_fetch', description: 'Fetch a URL and return its readable text. Args: url (string).', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'memory_add', description: 'Save a short, durable, non-sensitive fact or preference to local memory. Args: text (string), category (optional string).', parameters: { type: 'object', properties: { text: { type: 'string' }, category: { type: 'string' } }, required: ['text'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'memory_search', description: 'Search local long-term memory. Args: query (string), limit (optional number). Use when past facts/preferences may be relevant.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'recall', description: 'Search ALL past Nio sessions (the conversation archive) by keyword and return matching messages with their date and session. Use this to answer "what did we do/decide/say before?" or to find earlier context. Args: query (string) — keywords; limit (optional number, default 8).', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'memory_delete', description: 'Delete a local memory by id. Args: id (string).', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } } },
                    { type: 'function', function: { name: 'memory_note', description: 'Remember a durable fact about the USER so you know them in every future session. Use this when you learn something lasting: their name, where they live, their PC/device specs, family (partner/kids/pets), habits, music, sports, a rule they set for you, etc. It is saved to the user profile (memory.md), which you read at the start of each session. Args: text (string) — the fact to remember; action (optional: "note" to add [default], or "replace" to rewrite the whole profile).', parameters: { type: 'object', properties: { text: { type: 'string' }, action: { type: 'string', enum: ['note', 'replace'] } }, required: ['text'], additionalProperties: false } } },
    ];

    const tools = allTools.filter(t => this.enabledTools.includes(t.function.name));

    const _systemNotes = [];
    const apiMessages = [
      { role: 'system', content: this._fullSystemPrompt },
      ...messages.filter(m => !((m.role === 'system') && (typeof m.content === 'string') && (m.content === this._fullSystemPrompt))).map(m => {
        if (m.role === 'system') {
          _systemNotes.push(typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''));
          return null;
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          return { role: 'assistant', content: (typeof m.content === 'string' && m.content) ? m.content : null, tool_calls: m.tool_calls };
        }
        return {
          role: m.role,
          content: typeof m.content === 'string' || Array.isArray(m.content) ? m.content : JSON.stringify(m.content ?? ''),
                                                                                                                                         ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
                                                                                                                                         ...(m.name ? { name: m.name } : {})
        };
      }).filter(m => m !== null)
    ];

    if (_systemNotes.length) {
      apiMessages[0] = { role: 'system', content: this._fullSystemPrompt + '\n\n' + _systemNotes.join('\n') };
    }

    // Safety net: some llama.cpp Jinja chat templates (Qwen, Llama, Phi) require
    // the LAST non-system message to be a user message, else they raise
    // "No user query found in messages." If our window eviction or a stray
    // hidden note left a non-user message at the end, nudge a user role in so
    // the model still sees a valid conversation instead of a 500.
    if (!opts.noTools) {
      const last = apiMessages[apiMessages.length - 1];
      if (last && last.role !== 'system' && last.role !== 'user') {
        apiMessages.push({ role: 'user', content: '[Nio] Please answer the user\'s latest request using the context above.' });
      }
    }

    const url = `${this.baseUrl}/chat/completions`;
    const stream = opts.stream ?? false;
    const body = JSON.stringify({
      ...(this.modelId ? { model: this.modelId } : {}),
                                messages: apiMessages,
                                ...(opts.noTools ? {} : { tools, tool_choice: 'auto' }),
                                stream: stream,
                                ...(this.temperature !== null ? { temperature: this.temperature } : {}),
                                max_tokens: this.maxTokens || 8192,
                                chat_template_kwargs: { enable_thinking: false },
    });

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: opts.signal || AbortSignal.timeout(this.timeoutSeconds * 1000)
    });

    if (!resp.ok) {
      let errText;
      try { errText = await resp.text(); } catch { errText = '(empty response)'; }
      throw new Error(`Model API error ${resp.status}: ${errText}`);
    }

    if (stream && resp.body) {
      const contentType = resp.headers.get('content-type') || '';
      if (contentType.includes('event-stream') || contentType.includes('text/event')) {
        return this._streamResponse(resp, opts.onChunk, opts.signal);
      }
    }

    return await resp.json();
  }

  async _streamResponse(resp, onChunk, signal) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let fullContent = '';
    let accumulated = '';
    let apiError = null;

    if (signal) {
      signal.addEventListener('abort', () => { reader.cancel().catch(() => {}); }, { once: true });
    }

    const fmt = createLineFormatter((line) => {
      fullContent += line;
      if (onChunk) onChunk(line);
    });

      const toolCalls = [];
      let currentToolIdx = -1;
      let hasToolCall = false;

      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        let done, value;
        try { ({ done, value } = await reader.read()); }
        catch (err) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          throw err;
        }
        if (done) break;

        accumulated += decoder.decode(value, { stream: true });
        const lines = accumulated.split('\n');
        accumulated = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;
          try {
            const raw = trimmed.slice(6);
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              apiError = parsed.error.message || JSON.stringify(parsed.error);
              continue;
            }
            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;
            if (delta.content) fmt.push(delta.content);
            if (delta.tool_calls && delta.tool_calls.length > 0) {
              hasToolCall = true;
              for (const tc of delta.tool_calls) {
                const idx = Number.isInteger(tc.index) ? tc.index : (currentToolIdx >= 0 ? currentToolIdx : 0);
                while (toolCalls.length <= idx) toolCalls.push({ id: '', name: '', args: '' });
                currentToolIdx = idx;
                if (tc.id) toolCalls[idx].id = tc.id;
                if (tc.function?.name) toolCalls[idx].name += tc.function.name;
                if (tc.function?.arguments) toolCalls[idx].args += tc.function.arguments;
              }
            }
          } catch {}
        }
      }

      if (apiError) throw new Error(apiError);
      fmt.flush();

    if (!fullContent.trim() && toolCalls.length === 0) {
      throw new Error('Model returned an empty response (the context may be too large for this model).');
    }

    for (const tc of toolCalls) {
      try { tc.parsedArgs = JSON.parse(tc.args || '{}'); } catch { tc.parsedArgs = {}; }
    }

    return { choices: [{ message: { content: fullContent, tool_calls: hasToolCall ? toolCalls : null } }] };
  }

  async _executeTool(name, args) {
    if (!this.enabledTools.includes(name)) return `Tool is disabled: ${name}`;
    const impl = TOOL_MAP[name];
    if (!impl) return `Unknown tool: ${name}`;

    if (name === 'read') return await impl(args, this.workspace, this._contextDir);
    if (name === 'memory_note') return await impl(args, this.userProfile); // → memory.md profile (NOT the JSON store)
    if (name.startsWith('memory_')) return await impl(args, this.memory);
    if (name === 'recall') return await impl(args, this.sessions);
    return await impl(args);
  }
}
