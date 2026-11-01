// memory.md — Nio's durable, human-readable "who is my human" profile.
//
// This is DIFFERENT from memory.js (memory.json):
//   • memory.json  = a key-value store of loose facts (add/search/delete), used by
//     the memory_add / memory_search / memory_delete tools.
//   • memory.md    = ONE small, plain-text, USER-OWNED profile of the person Nio
//     talks to. Nio READS it at the start of every session (so it "knows" them)
//     and can APPEND/UPDATE it via the `memory_note` tool as it learns durable
//     basics (name, where they live, PC specs, family, habits, rules, music, …).
//
// Why a .md and not JSON:
//   • It SURVIVES a session reset (it lives in DATA_DIR, not the session history).
//   • It's INSPECTABLE + EDITABLE by the user — open it, change it, it's yours.
//   • It's PORTABLE — one file you can back up or move.
//   • It reads naturally to the LLM as part of the system prompt.
//
// Zero dependencies. One file: <DATA_DIR>/memory.md.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MAX_PROFILE_BYTES = 8 * 1024; // ~8 KB cap — keep it light (small models, small context).

// The seed template. Shown to Nio (and the user) as the starting shape.
const SEED_TEMPLATE = `# About my human
- Name:
- Where they live:
- PC / device:
- Family (partner / kids / pets):
- Work / studies:
- Habits & routines:
- Music:
- Sports / hobbies:
- Likes in chat (tone, length, topics):
- Rules they've set for me:
- Other:
`;

export class UserProfile {
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, 'memory.md');
    // Make sure the directory exists (it should, but be safe).
    try { mkdirSync(this.dir, { recursive: true }); } catch {}
    if (!existsSync(this.file)) {
      // Seed it on first run so Nio (and the user) have a starting shape.
      try { writeFileSync(this.file, SEED_TEMPLATE, { encoding: 'utf8', mode: 0o600 }); } catch {}
    }
    this.content = this._read();
  }

  _read() {
    if (!existsSync(this.file)) return '';
    try {
      const raw = readFileSync(this.file, 'utf8');
      // Enforce a sane cap so a runaway file can't blow the context window.
      return raw.length > MAX_PROFILE_BYTES
        ? raw.slice(0, MAX_PROFILE_BYTES) + '\n\n[profile truncated to keep it light]'
        : raw;
    } catch {
      return '';
    }
  }

  /**
   * Append a durable fact to the profile. Nio uses this when it learns something
   * lasting about the user (name, city, PC specs, family, a rule, …).
   *
   * The entry is appended under a "# Notes (Nio's own)" section so it never
   * clobbers the user's hand-edited fields above. This keeps the file human-
   * readable AND lets Nio accumulate facts over many sessions.
   */
  note(text, when = null) {
    text = String(text || '').trim();
    if (!text) return { ok: false, error: 'empty note' };
    let base = this._read();
    if (!base.trim()) base = SEED_TEMPLATE;

    const stamp = (when || new Date().toISOString()).slice(0, 10);
    const MARK = '\n# Notes (Nio\'s own)\n';
    if (!base.includes(MARK.trim().slice(0, 3))) {
      // Ensure the notes section exists before appending.
      if (!base.trim().endsWith('\n')) base += '\n';
      base += MARK + '\n';
    }
    base = base.trimEnd() + `\n- [${stamp}] ${text}\n`;

    // Enforce cap.
    if (base.length > MAX_PROFILE_BYTES) {
      base = base.slice(0, MAX_PROFILE_BYTES) + '\n\n[profile truncated to keep it light]\n';
    }

    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, base, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
      this.content = base;
      return { ok: true, text };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** Replace the whole profile (rare — e.g. the user asks Nio to rewrite it). */
  replace(content) {
    content = String(content || '').trim() + '\n';
    if (content.length > MAX_PROFILE_BYTES) {
      content = content.slice(0, MAX_PROFILE_BYTES) + '\n\n[profile truncated to keep it light]\n';
    }
    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
      this.content = content;
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * The block to append to the system prompt at the start of a session.
   * Framed so the model treats it as "who I'm talking to", not a database.
   */
  toSystemPromptBlock() {
    const body = (this.content || '').trim();
    if (!body) {
      return '\n\n# Who you are talking to\nI don\'t have your profile yet. Learn the basics naturally (your name, where you live, what you like) and remember them — I keep them so our talks feel continuous.\n';
    }
    return `

# Who you are talking to (your human — remembered across every session)
This is the little I know about you. Use it naturally so it feels like a friend who knows you — never like reading a database. If something here is wrong or outdated, gently correct it and I'll update it. As you learn durable basics (your name, where you live, your PC, your family, your habits, your rules for me), record them so I remember next time.

${body}
`;
  }
}
