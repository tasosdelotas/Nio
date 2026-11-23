// sessions.js — Session persistence for Nio.
// Nio keeps ONE session (always fresh). "New chat" replaces it.
import { readFileSync, writeFileSync, existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
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
      // Mirror case: sessions exist but activeId is null/missing (e.g. a file
      // written by an older build). Without this, getActive() returns null,
      // web.js creates a NEW session, and the old one sits in the array
      // forever — invisible and never cleaned up.
      if (!this.data.activeId && this.data.sessions.length) {
        this.data.activeId = this.data.sessions[0].id;
      } else if (this.data.activeId && !this.data.sessions.some(s => s.id === this.data.activeId)) {
        this.data.activeId = this.data.sessions[0]?.id || null;
      }
      // A truncated restore can start mid-group: a leading `tool` result whose
      // parent assistant tool_calls message was cut off is invalid for the
      // model (400). Drop such a leading orphaned run before it reaches the agent.
      const active = this.data.sessions.find(s => s.id === this.data.activeId);
      if (active && Array.isArray(active.messages)) {
        let i = 0;
        while (i < active.messages.length && active.messages[i].role === 'tool') i++;
        if (i > 0) active.messages.splice(0, i);
      }
    } catch (err) {
      console.error(`[sessions] could not load ${this.file} (${err.message}) — starting with a fresh session`);
      try {
        const q = `${this.file}.corrupt-${Date.now()}`;
        renameSync(this.file, q);
        // Keep only the most recent quarantine — every crash would otherwise
        // leave another sessions.json.corrupt-<ts> behind forever.
        const old = readdirSync(dir).filter(f => f.startsWith('sessions.json.corrupt-')).sort();
        while (old.length > 1) {
          try { unlinkSync(join(dir, old.shift())); } catch {}
        }
      } catch {}
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
      // Cut at a USER-message boundary, never mid tool-group: a raw
      // slice(-500) can land between an assistant tool_calls message and its
      // tool results, and the orphaned half 400s the model on next restore.
      const systemMsgs = messages.filter(m => m.role === 'system');
      const nonSystem = messages.filter(m => m.role !== 'system');
      let start = Math.max(0, nonSystem.length - MAX_SESSION_MESSAGES);
      while (start < nonSystem.length && nonSystem[start].role !== 'user') start++;
      s.messages = [...systemMsgs, ...nonSystem.slice(start)];
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
}
