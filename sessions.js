// sessions.js — Session persistence for Nio.
// Nio keeps ONE session (always fresh). "New chat" replaces it. The `search`
// method backs the `recall` tool (keyword-search across the archived session).
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Prevent a single session's sessions.json entry from growing infinitely during
// very long chats. We keep the system prompts + the last 500 messages.
const MAX_SESSION_MESSAGES = 500;

export class SessionStore {
  constructor(dir) {
    this.file = join(dir, 'sessions.json');
    this.data = { activeId: null, sessions: [] };
    this._load();
  }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || !Array.isArray(parsed.sessions)) throw new Error('invalid session data');
      const valid = parsed.sessions.every(s =>
        s && typeof s.id === 'string' &&
        Array.isArray(s.messages) &&
        s.messages.every(m =>
          m && typeof m === 'object' &&
          typeof m.role === 'string' &&
          ['user', 'assistant', 'tool', 'system'].includes(m.role)
        )
      );
      if (!valid) throw new Error('invalid session data');
      this.data = parsed;
      if (this.data.activeId && !this.data.sessions.some(s => s.id === this.data.activeId)) {
        this.data.activeId = this.data.sessions[0]?.id || null;
      }
    } catch (err) {
      console.error(`[sessions] could not load ${this.file} (${err.message}) — starting with a fresh session`);
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`); } catch {}
      this.data = { activeId: null, sessions: [] };
    }
  }

  _save() {
    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
    } catch (err) {
      console.error(`[sessions] save failed: ${err.message}`);
      try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
    }
  }

  getActive() {
    if (!this.data.activeId) return null;
    return this.data.sessions.find(s => s.id === this.data.activeId) || null;
  }

  get(id) {
    return this.data.sessions.find(s => s.id === id) || null;
  }

  create() {
    const session = {
      id: randomUUID(),
      started: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      messages: [],
    };
    this.data.sessions.push(session);
    this.data.activeId = session.id;
    this._save();
    return session;
  }

  saveActive(messages) {
    const s = this.getActive();
    if (!s) return null;
    if (messages.length > MAX_SESSION_MESSAGES) {
      const systemMsgs = messages.filter(m => m.role === 'system');
      const recentMsgs = messages.filter(m => m.role !== 'system').slice(-MAX_SESSION_MESSAGES);
      s.messages = [...systemMsgs, ...recentMsgs];
    } else {
      s.messages = messages;
    }
    s.lastActive = new Date().toISOString();
    this._save();
    return s;
  }

  // Nio: "one session, always fresh." Replace the current session with a brand-new
  // empty one (do NOT keep/archive the old one). Returns the new session.
  resetToNew() {
    this.data.sessions = [];
    this.data.activeId = null;
    return this.create();
  }

  // Keyword-search across the session (newest first) and return matching
  // messages. Backs the `recall` tool. Each result: { sessionId, sessionDate, role, text, score }.
  search(query, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const terms = q.split(/\s+/).filter(w => w.length >= 2);
    if (!terms.length) return [];
    const results = [];
    for (const s of this.data.sessions) {
      for (const m of s.messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const text = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => (p && p.text) || '').join(' ') : '');
        if (!text || !text.trim()) continue;
        const lower = text.toLowerCase();
        let score = 0;
        for (const t of terms) if (lower.includes(t)) score++;
        if (score > 0) {
          results.push({ sessionId: s.id, sessionDate: s.lastActive, role: m.role, text: text.trim(), score });
        }
      }
    }
    results.sort((a, b) => (b.score - a.score) || (new Date(b.sessionDate) - new Date(a.sessionDate)));
    return results.slice(0, Math.max(1, Number(limit) || 8));
  }
}
