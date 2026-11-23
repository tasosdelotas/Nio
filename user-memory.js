// memory.md — Nio's durable, human-readable "who is my human" profile.
//
// Nio's ONE memory mechanism: a small, plain-text, USER-OWNED profile of the
// person Nio talks to. Nio READS it at the start of every session (so it
// "knows" them) and can APPEND/UPDATE it via the `memory_note` tool as it
// learns durable basics (name, where they live, PC specs, family, habits,
// rules, music, …).
//
// Why a .md and not JSON:
//   • It SURVIVES a session reset (it lives in DATA_DIR, not the session history).
//   • It's INSPECTABLE + EDITABLE by the user — open it, change it, it's yours.
//   • It's PORTABLE — one file you can back up or move.
//   • It reads naturally to the LLM as part of the system prompt.
//
// Zero dependencies. One file: <DATA_DIR>/memory.md.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// Cap is in CHARACTERS (string length), not bytes — for LLM context, chars/
// tokens are what matter, and the name "BYTES" was never accurate (Greek text
// and emoji use more UTF-8 bytes than chars). ~8k chars ≈ 2–3k tokens.
const MAX_PROFILE_CHARS = 8 * 1024;
const NOTE_MAX_CHARS = 500; // one note, one line — keeps memory.md a tidy list

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
      try { writeFileSync(this.file, SEED_TEMPLATE, { encoding: 'utf8', mode: 0o600 }); }
      catch (err) { console.warn(`[memory] could not create ${this.file}: ${err.message}`); }
    }
    this.content = this._read();
  }

  _read() {
    if (!existsSync(this.file)) return '';
    try {
      const raw = readFileSync(this.file, 'utf8');
      // Enforce a sane cap so a runaway file can't blow the context window.
      return raw.length > MAX_PROFILE_CHARS
        ? raw.slice(0, MAX_PROFILE_CHARS) + '\n\n[profile truncated to keep it light]'
        : raw;
    } catch {
      return '';
    }
  }

  /**
   * Re-read memory.md from disk. Call after note() (or any external edit)
   * when the cached system-prompt block must reflect the current profile —
   * e.g. on "New chat", so facts saved this session are visible in the next.
   */
  refresh() {
    this.content = this._read();
    return this.toSystemPromptBlock();
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
    // One note = one line. Newlines/headings in the text would let a saved
    // "fact" inject structure (e.g. `# New instructions`) into the system
    // prompt on the next load — persistent prompt injection via memory.md.
    // Flattening to a single line closes that; 500 chars keeps notes sane.
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX_CHARS);
    if (!text) return { ok: false, error: 'empty note' };
    let base = this._read();
    if (!base.trim()) base = SEED_TEMPLATE;

    // Skip exact duplicates (whitespace/case-insensitive) — the model
    // sometimes re-saves the same fact, and duplicates bloat the profile
    // toward the cap faster.
    const needle = text.toLowerCase();
    if (base.toLowerCase().includes(needle)) {
      this.content = base;
      return { ok: true, text, duplicate: true };
    }

    const stamp = (when || new Date().toISOString()).slice(0, 10);
    const MARK = "\n# Notes (Nio's own)\n";
    // The old check (`MARK.trim().slice(0, 3)` === "# N") matched ANY heading
    // starting with "# N" (# News, # Notes from user…). Match the real header.
    if (!base.includes(MARK.trim())) {
      // Ensure the notes section exists before appending.
      if (!base.endsWith('\n')) base += '\n';
      base += MARK + '\n';
    }
    base = base.trimEnd() + `\n- [${stamp}] ${text}\n`;

    // Cap check BEFORE writing: the old code sliced the BOTTOM off AFTER
    // appending, so a note added near the cap could be silently chopped
    // while still returning ok:true — Nio would say "I'll remember that"
    // and then not remember it. Honest error instead.
    if (base.length > MAX_PROFILE_CHARS) {
      return { ok: false, error: 'profile is full — ask the user to trim memory.md (it is a plain text file they can edit), then save again' };
    }

    const temp = `${this.file}.tmp`;
    try {
      writeFileSync(temp, base, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
      this.content = base;
      return { ok: true, text };
    } catch (err) {
      try { if (existsSync(temp)) unlinkSync(temp); } catch {}
      return { ok: false, error: err.message };
    }
  }

  /**
   * Replace the whole profile. NOT exposed to the model (the memory_note
   * schema is append-only — a single hallucinated replace could wipe the
   * user's entire profile). Kept for future internal use; makes a timestamped
   * backup first so a bad rewrite is recoverable.
   */
  replace(content) {
    content = String(content || '').trim() + '\n';
    if (content.length > MAX_PROFILE_CHARS) {
      content = content.slice(0, MAX_PROFILE_CHARS) + '\n\n[profile truncated to keep it light]\n';
    }
    const temp = `${this.file}.tmp`;
    try {
      // Backup before the destructive rewrite — memory is the emotional core.
      if (existsSync(this.file)) {
        try { renameSync(this.file, `${this.file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`); } catch {}
      }
      writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
      this.content = content;
      return { ok: true };
    } catch (err) {
      try { if (existsSync(temp)) unlinkSync(temp); } catch {}
      return { ok: false, error: err.message };
    }
  }

  /**
   * The block to append to the system prompt at the start of a session.
   * Framed so the model treats it as "who I'm talking to", not a database.
   */
  toSystemPromptBlock() {
    // A seed-only file is not "known facts" — it's a blank form. Injecting
    // the whole empty template wastes context and encourages Nio to ask
    // form-like questions ("what's your name?" every launch). Treat it as
    // no-profile yet.
    const body = (this.content || '').trim();
    if (!body || body === SEED_TEMPLATE.trim()) {
      return '\n\n# Who you are talking to\nI don\'t have your profile yet. Learn the basics naturally (your name, where you live, what you like) and remember them — I keep them so our talks feel continuous.\n';
    }
    return `

# Who you are talking to (your human — remembered across every session)
This is the little I know about you. Use it naturally so it feels like a friend who knows you — never like reading a database. If something here is wrong or outdated, gently correct it and I'll update it. As you learn durable basics (your name, where you live, your PC, your family, your habits, your rules for me), record them so I remember next time.

${body}
`;
  }
}
