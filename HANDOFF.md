# Nio — HANDOFF (read this first)

> **For a fresh AI session:** read this before touching Nio. Nio is a small, light, single-purpose
> **local AI friend** in one file. It is a **separate product** from the ismini app (different folder,
> different identity), built by the same person (tasos / Tasos Delotas).
>
> **STATUS: COMPLETE, WORKING, CLEAN, RE-PACKAGED (2026-11-01).** Nio is a complete, running, local AI
> friend: model wired in (Qwen3.5-2B), cross-session user memory (memory.md), read-only tools, voice
> (TTS/STT), **solid red** user bubble + avatar, Blue theme, crisp taskbar icon, and packaged as a single
> **~1.3 GB `Nio.AppImage`** (2B model — chosen so Nio ships as ONE file under the 2 GB GitHub Release cap). All dead code has been
> **fully removed**, the ❓ Help button is fixed, and a real latent AppImage bug (llama-server binary not
> found) was caught and fixed. tasos: **"EXCELLENT WORK. IT'S A MASTERPIECE!!!"**
> (Original 3-day build: tasos confirmed "NIO is loading SUPERFAST… ready for chat INSTANTLY… working
> like a charm" + "nio is alive again!" after the `messageText` fix.)

---

## ✅ TO DO (all done 2026-11-01)

1. ~~FINAL-FINAL CHECK of everything~~ → **DONE.** Full line-by-line re-audit (all JS via `node --check`,
   both inline `<script>` modules, all routes, tool handlers, config.json, launcher, install/uninstall,
   README, AppImage build). Found + fixed **14** items of dead code / misleading text (see the session log
   below). Boot test + a **real send** ("hello" round-trip) both passed from the folder AND from the AppImage.
2. **❓ Help button (known bug) → FIXED.** Root cause: the `#helpBtn` element + `#helpModal` markup + CSS
   all survived the cleanup, but the **click-listener JS had been removed** — an orphaned button. Re-wired:
   button toggles the modal; ✕ closes; backdrop-click closes; `Escape` closes. Verified parsing + in served HTML.
3. ~~AppImage rebuild + rename to `Nio.AppImage`~~ → **DONE.** Rebuilt from the clean source with
   `appimagetool` (type-2 runtime, same BuildID as the original) → `/home/tasos/Labor/Nio.AppImage` (2.6 GB).
   Caught + fixed a **real latent bug** it exposed: `llama-backend.js` couldn't find the llama-server binary
   in the AppImage layout (`ENOENT`) — added the `usr/lib/llama-cpp/llama-server` candidate. Old stale build
   deleted by tasos.
4. **Bonus (this session): user chat bubble + avatar made SOLID red.** Bubble `background` `.12 → .30`,
   border `.35 → .80`; removed the avatar's `.7`/`.6` opacity fades. tasos: "fine as is but too faded — make
   it a little bit more solid."
5. **Bonus (this session): removed the version badge from the UI.** The footer `Nio v1.0.0` line is gone —
   tasos wants users to see Nio as a *friend*, not a versioned "thing." Nio has no versions (one-stop app;
   next release ships under a different name). Removed the `app-version` element + its CSS from `index.html`,
   the now-unused `APP_VERSION` + `NIO_VERSION` substitution in `web.js`, and dropped `"version"` from
   `package.json`. AppImage rebuilt + re-verified (version gone from served HTML, boot + send green).
6. **Bonus (this session): removed the model-name badge from the header.** The `#modelBadge` chip (was showing
   `Qwen3.5-4B-Q4_K_M.gguf`) is gone — Nio is the whole *being*, not "Nio + a model in the background." Removed
   the `#modelBadge` element + CSS from `index.html`, dropped the `badge` var, neutralized `paintBackend()`'s
   badge writes (now just drives the status dot), simplified `setModel(id)` to only toggle the dot, and removed
   the dead `modelSwitch` SSE handler (it toasted the model name). Header now shows just **NIO** + status dot
   + context chip. AppImage rebuilt + re-verified (0 model-name refs in served HTML, **NIO** logo intact,
   boot + send green).
7. **Bonus (this session): the boot toast no longer names the model.** When Nio comes up, the UI toasted
   `Qwen3.5-4B-…/Qwen3.5-4B-Q4_K_M.gguf is ready`. Changed it to **"Nio is ready"** (and the error case to
   **"⚠️ Nio could not start"**) in `web/index.html`. Also removed the now-dead `backendModel` variable (was
   write-only). AppImage rebuilt + re-verified (served HTML shows `toast('Nio is ready')`, model reaches
   `ready`, ports cleaned up).
8. **Bonus (this session): ONE icon everywhere — the transparent `nio.png`.** tasos noticed the AppImage
   taskbar icon was a blurry Nio in a **black square** while a clean install showed the nice **transparent** one.
   Root cause: `install.sh` registers the transparent icon in the hicolor theme (matched by `--class=nio`), but
   the AppImage's `AppRun` passed `--app-icon=web/nio-taskbar.png` (a SOLID/black PNG) and never registered the
   theme. FIX: (a) `AppRun` now has a `register_icon` step that registers the transparent `nio.png` into the
   hicolor theme on every launch (idempotent, mirrors install.sh) AND dropped the black `--app-icon` flag;
   (b) **deleted ALL the black-background icon assets** — `web/favicon-{16,32,48,64,180,192,256,512}.png`,
   `web/favicon.ico`, `web/nio-taskbar.png`, `web/nio-taskbar-256.png`, `web/icons/icon-{192,512}.png`, and the
   old `web/favicon-transparent.bak-20261030/` backup. `web/` now has ONLY `nio-avatar.png` (the transparent
   in-chat face) left. (c) Rewired everything to the single root `nio.png`: `web.js` favicon routes → one
   `/nio.png` route; `index.html` → single `<link rel=icon href="/nio.png">`; `manifest.webmanifest` →
   `/nio.png`; `nio.desktop` → `Icon=$HOME/Nio/nio.png`. Verified from folder: `/nio.png` serves 200, old
   `/favicon.ico` → 404, page + manifest point to `/nio.png`. **SQUARE MASTER (final):** the old `nio.png`
   was 1144×858 (landscape) — fine for the taskbar but the title-bar/tab favicon looked blurry + cropped.
   Generated a **square transparent master** (`convert nio.png -background none -gravity center -extent
   1144x1144`) and made it the single `nio.png` (the old landscape one is kept as `nio-landscape-master.png`).
   Now `nio.png` = 1144×1144 transparent, Nio centered — crisp in the title-bar AND transparent in the
   taskbar. AppDir `nio.png` + hicolor set updated to the square version. **NOTE: AppImage NOT yet rebuilt
   with the icon fix** (tasos is batching changes before the next rebuild).
9. **Optional: Nio's own theme** (Marble is the accepted stop-gap). Only if tasos asks.
10. **Model swapped to Qwen3.5-2B (2026-11-01) → single-file Nio.** tasos dropped to the 2B brain
   (`models/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf`, 1.2 GB) so the whole Nio fits under the 2 GB GitHub
   Release cap and can be published as ONE file (no separate model download). `pickModel()` auto-picks any
   `q4_k_m` GGUF, so no code change needed. Rebuilt the AppImage → **1.3 GB**, verified end-to-end
   (extract clean, boot → ready on the 2B, all routes 200, `<title>Nio</title>`, 0 version strings, 0
   model-name refs, real send ok). Moved to `/home/tasos/Labor/Nio.AppImage`. Updated README + BUILD.md
   (4B→2B, 2.6 GB→1.3 GB). Publishing plan: **GitHub = code-only repo + a release whose "download" links
   to the full Nio on tasos's own `ismini.app`** (Cloudflare); the site will advertise Nio too.
11. **FINAL REBUILD (2026-11-01) + real bug fix: `/nio.png` was 404 in every AppImage build.** tasos gave
   up on the title-bar favicon ("let the system decide") — reverted to the ORIGINAL landscape `nio.png`
   (1144×858), deleted `web/favicon.png` + the `/favicon.png` route, removed the dead `/marble.jpeg` +
   `/icons/icon-*` routes and the dead marble CSS block (zero dead code). Rebuilt from BUILD.md. The verify
   step caught it: **`/nio.png` returned 404 in the AppImage** — `nio.png` was only at the AppDir root, but
   web.js serves it from `__dirname` (`usr/share/nio/`). Fixed the AppDir (copy `nio.png` into
   `usr/share/nio/`) AND the BUILD.md one-liner + layout note + gotcha so it can't recur. Rebuilt → re-verified
   from the AppImage: `/nio.png` → 200 (665 KB), all routes 200, `<title>Nio</title>`, **0 version strings**,
   blue theme, backend `ready`, real send `ok`. Moved to `/home/tasos/Labor/Nio.AppImage` (2.74 GB).
   NOTE: title-bar favicon is now "left to the system" (served `/nio.png?v=2`); the crisp one tasos cares
   about is the TASKBAR icon (hicolor set), which is unchanged and good.

---

## What Nio is (one line)
**One file, double-click → a light, local AI *friend* that remembers you.** Not a tool, not a pipeline —
a companion. Read-only, one session, one model, no vision, no cloud, no accounts.

## The "being" architecture (the magic)
- **AppImage = DISPOSABLE BODY.** Extracts to a hidden temp folder (user never sees it), cleaned on exit.
  Contains: bundled Node + llama.cpp + web/code + the 2.8 GB model GGUF (embedded).
- **`~/Nio/` = PERMANENT SOUL** (never cleaned): `memory.md` (user profile), `memory.json` (key-value memory),
  `sessions.json`, `config.json`, and `models/` (the brain, auto-picked).
- First run: AppImage copies the model into `~/Nio/models/` (one-time "settling in").
- Model = **Qwen3.5-4B-Q4_K_M.gguf** (auto-picked from `~/Nio/models/`). To upgrade the brain, drop a new
  GGUF there — no code change.
- Ports: **web 8791**, **llama 8091** (distinct from ismini's 8787/8080 so they can run at the same time).

---

## Everything done 2026-11-01 (re-audit, Help fix, solid bubble, re-package)

**The ❓ Help button bug — FIXED (was the known bug from 2026-10-31 night).**
- Root cause: the `#helpBtn` button, `#helpModal` markup, and all its CSS survived the dead-code cleanup,
  but the **JavaScript that listened for the click had been removed** — an orphaned, unclickable button.
- Fix (in `web/index.html`): wired the button to toggle `#helpModal`; added the ✕ close button, backdrop-click
  to close, and `Escape` to close. Removed the one unused helper I introduced. Inline modules re-verified.

**Help → Uninstall text (tasos's request).** Replaced the `./uninstall.sh` row + its scary warning with the
warm, simple line that matches the README: **"Just delete the Nio.AppImage and the `Nio` folder in your Home folder."**

**User chat bubble + avatar — made SOLID red (was faded).**
- `.msg.user .bubble` background `rgba(248,81,73,.12) → .30`; border `rgba(248,81,73,.35) → .80`.
- `.who .avatar-user` — removed the `opacity:.7` fade; the avatar SVG body `opacity:.6 → solid`.
- tasos: "is fine as is but too faded. make it a little bit more solid."

**Full dead-code sweep (A+B+C, tasos approved). 14 items removed/fixed — "zero dead code" standard.**
- `web.js` **678 → 497 lines**: removed the `ROUTES`/`registerRoute` map + 30 stub `registerRoute` calls
  (incl. the stale `/confirm`), the broken never-called `spawnDetached()` (called `spawn` unimported), the
  stale `.mm-*` CSS injection, dead `STATIC_ASSETS`/`cacheFile`, the duplicated `/v1/models` fetch in `/events`,
  the entire dead `GET /api/models` GGUF scanner, vestigial `LEGACY_TOOL_PREFIX`/`cleanMessage`, 2 unused imports,
  and the stale "open 🤖 Models and download one" `/send` message (→ "Nio's model engine could not start").
- `agent.js` **1056 → 1047**: removed the always-false `execInThisTurn` + its "ran an exec command" note;
  cleaned the exec example in the empty-output note (→ a `web_search` example); fixed `stripRepeatedToolList`
  detection (`write(`/`exec(` → `web_search(`/`web_fetch(`); `toolRead` image + binary messages no longer say
  "attach in chat" / "use exec with pdftotext" (→ "I work with text only" / "I can only read plain-text files");
  tidied two "exec dump" comments.
- `nio` launcher: removed the whole `--progress-window` / `OPEN_MODE="progress"` / `/update-progress` in-app-updater
  block (opened a page that no longer exists).
- `install.sh`: removed the updater-only `--no-stop` / `NO_STOP` flag. `uninstall.sh`: removed `.nio-update.zip` /
  `.nio-update-temp` cleanup. `llama-backend.js`: fixed a stale comment referencing the removed `/api/models`.
- **Verified:** all 9 JS `node --check`, both inline modules parse, all 3 shell scripts `bash -n`, both JSON parse,
  zero removed-feature references in app code, boot + **real send** ("hello" round-trip) both green.

**Re-packaging → `Nio.AppImage` (the final stage).**
- Reverse-engineered the old AppImage (type-2: ELF runtime + squashfs `AppDir`). Internal layout:
  `AppRun`, `NIO.desktop`+`nio.png`, `usr/lib/node`, `usr/lib/llama-cpp`, `usr/share/nio/` (app code +
  `models/Qwen3.5-4B-GGUF/*.gguf`).
- Assembled a clean AppDir from the current source (no stale `image-input.js`, no `favicon-transparent.bak-*`),
  wrote a Nio-named `AppRun` (same "settling in" + browser `--app` logic) + `.desktop` + hicolor icon set.
- Installed `squashfs-tools` + the standard AppImage runtime (`appimagetool`), built **`Nio.AppImage`** (2.6 GB,
  same runtime BuildID as the original).
- **Real latent bug caught by the AppImage test:** `llama-backend.js` `_findBinary()` couldn't find the
  llama-server in the AppImage layout (looked in `__dirname/llama-cpp/…`; the binary is at `usr/lib/llama-cpp/`),
  so the model failed with `spawn llama-server ENOENT`. Fix: added `join(__dirname,'..','..','..','usr','lib','llama-cpp','llama-server')`
  as the top candidate (harmless in folder-run). Rebuilt, then verified end-to-end FROM the AppImage:
  self-extract OK, boot → `ready`, **real send** ("hello from Nio" → Nio answered), UI + assets served (200).
- Deliver note: the `deliver_file_to_user` tool caps at 2 GiB, so the 2.6 GB AppImage was **moved** into
  `/home/tasos/Labor/Nio.AppImage`. Old `NIO-1.0.0-x86_64.AppImage` deleted by tasos.

**Re-verified line counts (2026-11-01):** web.js 497 · agent.js 1047 · llama-backend.js 319 · sessions.js 125 ·
memory.js · user-memory.js · index.html 1334 · nio 243 · install.sh 322 · uninstall.sh 98.
**Nio has NO version** — it is a one-stop app (next release ships under a different name). Do not add
version numbers, a version badge, or in-app updates back in.
**Nio has NO visible "model"** — it is one whole *being*. Do not surface the model name (Qwen GGUF), a
model badge, or model-switching to the user. (Internally it still runs on Qwen3.5-4B; that stays hidden.)

---

## Everything done in the 3-day session (2026-10-29 → 2026-10-31)

### Core build (from ismini, trimmed)
- Full copy of ismini → renamed every `ismini`→`Nio` (code, config, UI, identifiers, localStorage keys).
  Verified zero "ismini" strings remain in Nio code.
- Feature trims (tasos's spec): read-only tools (no write/edit/delete/exec/sudo), one session (no
  multi-session), one model (no model manager / HF download), no vision, no file/folder picker, no
  in-app updater. KEPT: web search+fetch, file-read, TTS/STT, Live voice, context chip (8k/16k/32k),
  Pause, New chat, Help modal, window-size remember, cross-session memory.
- Theme = **Marble** (one theme, forced; light/papyrus theme + switcher removed).
- Model wired in: Qwen3.5-4B, auto-picked.
- **Cross-session user memory:** `user-memory.js` (`UserProfile` → `~/Nio/memory.md`). Nio reads it at the
  start of EVERY session. `memory_note` tool lets Nio record durable facts. The user can open/edit
  memory.md directly — it's theirs.
- **AppImage built** (2.6 GB, model embedded) — tasos confirmed it works beautifully.

### Icons (final state)
- **ONE icon source everywhere:** `nio.png` — the **ORIGINAL wide-pose master (1144×858)**, restored
  per tasos. No black-background variants, no separate favicon set.
- **Taskbar icon — CRISP ✅ (the one tasos cares about).** Registered in the hicolor theme
  (matched by `--class=nio`) with properly-resized tiles at 16→512px (Lanczos, fit-to-square).
- **Title-bar favicon — LEFT TO THE SYSTEM.** tasos: "let the system decide what ever it will use as
  title bar favicon. user doesnt care about that." So `index.html` just points at `/nio.png?v=2` (bump
  ?v=N on any icon change — the route caches 1 yr and Nio reuses the normal browser profile). No custom
  favicon file, no /favicon.png route.
  - History: tried a square crop (846×856) and a face/bust `web/favicon.png` — both still read soft in
    the KWin-Wayland title bar; tasos gave up on it. Both experiments reverted; face favicon deleted.
  - `AppRun` `register_icon` was fixed to RESIZE each hicolor slot (it used to `cp` the full master
    in) — kept, since it makes the taskbar tiles crisp.
- **In-chat avatar** — `web/nio-avatar.png` (128px). tasos: "fine."
- **User bubble — RED** (`--user: #f85149`). tasos: "make it red."
- Icon files now present: `nio.png` (1144×858 master — taskbar/desktop/manifest/favicon),
  `web/nio-avatar.png` (in-chat). All black-background/favicons/`nio-taskbar*`/`icons/` variants are
  gone; the near-square crop + face favicon + `nio-landscape-master.png` duplicate all removed.

### README.md (reformed)
- "One thing" framing: Nio is the being, not "a file with a model." Warm, for everyone.
- "One download, one click, done." / "Click on the Nio.AppImage. Done."
- Removed technical details (server port, install.sh steps).
- Model name (Qwen3.5-4B) only in a small footer at the bottom (honesty, not a crook).
- Uninstall: "Just delete the Nio.AppImage and the `Nio` folder in your Home folder."

### Full dead-code cleanup (tasos approved "option 1: A+B+C+D, file by file")
This is the big one. Removed ALL ismini-leftover dead code contradicting Nio's design.

**Final file sizes:**
| File | Before → After |
|------|---------------|
| `agent.js` | 1318 → 1056 |
| `web.js` | 1261 → 678 |
| `sessions.js` | 206 → 125 |
| `llama-backend.js` | 368 → 315 |
| `index.html` | 2229 → 1329 |
| `image-input.js` | **DELETED** (was 60 lines; its one constant inlined into web.js) |
| `config.json.bak-sysprompt-20261031` | **DELETED** (old system-prompt backup) |

**What was removed (summary):**
- **agent.js:** toolWrite/toolEdit/toolDelete/toolExec + DANGEROUS_PATTERNS + killActiveChild + all sudo
  plumbing + exec/write/edit/delete tool descriptions + the destructive/privileged confirmation block
  (`_requestConfirmation`) + the image/vision block + supportsVision. Fixed `pause()` (was calling
  deleted `killActiveChild()`).
- **web.js:** image-attach in /send (now text-only) + /api/sudo + all /api/sessions* + /api/model/switch +
  the entire HuggingFace model-manager + download stack + /api/pick-file + the whole `requestConfirmation`
  / `pendingConfirm` / `CONFIRM_TIMEOUT_MS` pipeline + the `/confirm` route + unused imports.
- **sessions.js:** list/switchTo/archiveAndCreate/delete/deleteAll/_enforceLimit (kept create/getActive/get/
  saveActive/resetToNew/search).
- **llama-backend.js:** _findMmproj + all mmproj/vision (currentMmproj, --mmproj, vision status).
- **index.html (the tail, finished tonight):** Model-Manager modal markup (mmModal + all mm-*), session-dropdown
  markup (sessions-wrap/sessionsBtn/sessionsDrop), `<select id="modelSelect">`, `<button id="modelsBtn">`,
  dock-progress-chip, their CSS (#modelSelect, #modelsBtn, .sessions-*, .confirmcard/confirm-*, #sudoBtn,
  #fileBtn/#folderBtn/#imageBtn), the showConfirm/hideConfirm/answerConfirm JS, showLiveConfirm/
  hideLiveConfirm JS, the dead `await loadSessions()` in newChat(), SSE confirm/confirmed cases, the
  `if (livePending)` guard. Cleaned the nio-trim `<style>` block. Restored #helpBtn CSS.
- **image-input.js:** deleted (Nio is text-only; `MAX_SEND_BODY_BYTES` inlined into web.js as `6 * 1024 * 1024`).

### Bugs fixed (this session)
1. **Live voice "tap to send" bug:** Live mode was showing a "Heard: … — tap to send" card instead of just
   talking. Root cause: the VAD loop sent the utterance only `if (sudoOn)` and otherwise called
   `showLiveConfirm(text)`. With sudo hard-coded OFF, the confirm branch was the ONLY path. FIX: Live now
   ALWAYS auto-sends (`input.value = text; lastInputValue = text; send();`). `showLiveConfirm` removed (dead).
2. **"text is not defined" runtime error (TONIGHT, the last bug):** after the dead-code cleanup, sending
   any message gave toast "network error: text is not defined." Root cause: the client `send()` in
   index.html had `body: JSON.stringify({ text: messageText, image })` — `messageText` and `image` were
   ismini leftovers that don't exist in Nio. `ReferenceError` was caught by the `catch` → "network error."
   FIX: `body: JSON.stringify({ text: content })`. tasos: "nio is alive again!"
3. **`/confirm` route + `pendingConfirm` in web.js:** referenced a `pendingConfirm` that was set by
   `requestConfirmation()` (itself dead). Removed the whole pipeline (see above).

---

## Important files & paths
- `/home/tasos/Labor/Nio/` — **Nio source** (we are here).
- `/home/tasos/Labor/Nio/web/index.html` — the UI (1338 lines, clean).
- `/home/tasos/Labor/Nio/web.js` — Node HTTP server (497 lines).
- `/home/tasos/Labor/Nio/agent.js` — agent loop (1047 lines). Tools: read, web_search, web_fetch,
  memory_add/search/delete, recall, memory_note.
- `/home/tasos/Labor/Nio/sessions.js` — one-session store (125 lines).
- `/home/tasos/Labor/Nio/llama-backend.js` — llama.cpp bridge (319 lines).
- `/home/tasos/Labor/Nio/user-memory.js` — UserProfile → `~/Nio/memory.md`.
- `/home/tasos/Labor/Nio/memory.js` — MemoryStore → `memory.json`.
- `/home/tasos/Labor/Nio/web/live-tts.js` — TTS/Live-voice tracker.
- `/home/tasos/Labor/Nio/config.json` — Nio's brain (persona + tools + system prompt).
- `/home/tasos/Labor/Nio/nio` — folder-run launcher (web 8791, opens browser `--app`).
- `/home/tasos/Labor/Nio/install.sh` / `uninstall.sh` — proper install (registers crisp icons).
- `/home/tasos/Labor/Nio/README.md` — reformed (one-thing framing, model name in small footer).
- `/home/tasos/Labor/Nio/BUILD.md` — **the AppImage build recipe** (layout, tools, steps, one-liner script).
- `/home/tasos/Labor/Nio/AppRun` — the AppImage "being" launcher (settles model → boots web.js → opens browser).
- **`/home/tasos/Labor/Nio.AppImage`** — **THE SHIPPABLE BUILD** (2.6 GB, clean source + all fixes + the
  llama-binary fix). Rebuilt 2026-11-01. One file, double-click, done. (Old versioned build was deleted.)
- `/home/tasos/Labor/Nio/node/` + `/home/tasos/Labor/Nio/llama-cpp/` — bundled (do NOT audit internals).
- **AppImage build recipe — see [BUILD.md](BUILD.md).** The `AppRun` launcher is saved in the source folder
  (`/home/tasos/Labor/Nio/AppRun`). `BUILD.md` has the exact AppDir layout, tool install, build + verify steps,
  and a one-liner build script. Tooling: `squashfs-tools` + `appimagetool` (type-2 runtime).
  Rebuild command in short: assemble the AppDir (layout in BUILD.md), then `appimagetool <AppDir> Nio.AppImage`.
- `~/Nio/` — **permanent soul:** memory.md, memory.json, sessions.json, config.json,
  models/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf.
- `/home/tasos/Labor/ismini-linux/` — the **ismini APP** (sibling, different product). Nio is NOT a branch.

## Ground rules (carry over from ismini)
- **Minimalism first.** If a feature isn't "friendship," cut it.
- **Target user = newcomers / everyone**, not power users. Warm/fun, not cold.
- **AI should feel fun, not cold.** One nice theme, warm personality, soul.
- **100% local, no cloud, no accounts.** Read-only, no vision.
- **The "magic" of one file** — no visible extraction folder. The user feels Nio as ONE thing.
- **Nio is a "one-stop app" — no in-app updates.** Next release ships under a NEW name (maybe "Jenny").
- **The AppImage must be named `Nio.AppImage`** (not versioned).
- **Byline / author: Tasos Delotas.**

## Verification status (last run, 2026-11-01 — after the sweep + re-package)
- All 9 JS files pass `node --check`; both inline `<script>` modules in index.html parse (as ES modules).
- All 3 shell scripts (`nio`, `install.sh`, `uninstall.sh`) pass `bash -n`; `config.json` + `package.json` parse.
- **Zero dead references** remain (full grep sweep across app code: spawnDetached, registerRoute, NO_STOP,
  update-progress, progress-window, .nio-update, LEGACY_TOOL_PREFIX, cleanMessage, STATIC_ASSETS, .mm-item,
  execInThisTurn, `/api/models`, `open 🤖 Models` — all 0). Zero `image-input.js` in the packaged AppImage.
- **Folder run:** boot → model `ready`; `/api/models` + `/confirm` correctly 404; real send ("hello") round-trips.
- **AppImage run:** self-extract OK; boot → `ready`; real send ("hello from Nio") answered; UI (title, solid bubble,
  Help button + JS + new uninstall text, `/live-tts.js`, avatar, marble) all served 200.
- **KNOWN BUG (Help button) FIXED** and verified in served HTML. **llama-server `ENOENT` (AppImage) FIXED.**
- tasos: **"EXCELLENT WORK. IT'S A MASTERPIECE!!!"** — Nio is complete, clean, working, and re-packaged.

## Observations / gotchas
- `edit_file_tool` is finicky on very long multi-line matches. For large contiguous blocks, a verified
  line-range splice via `node -e` (check first+last line before splice) is reliable.
- `pkill -f <pattern>` that matches the shell's own command line self-kills the shell — avoid, or use
  PID-based kills.
- The client `send()` in index.html was the LAST hiding place of an ismini leftover (`messageText`,
  `image`). Lesson: when removing a feature, grep for the feature's variables in the CLIENT JS too,
  not just the server.
- `web.js` `/send` needs `MAX_SEND_BODY_BYTES` (now inlined, was from image-input.js).
- `agent.js` `pause()` only does `this._abort?.abort()` (killActiveChild was removed).
- The **Help modal** is a live feature — keep it. `modelBadge` is the live header status dot — keep it.
- Nio runs from the folder for fast testing (tasos does NOT do a clean install each time). For a crisp
  taskbar icon, `install.sh` must have run (registers the hicolor icon set).
- **The AppImage runs from a FUSE mount** (`/tmp/.mount_Nio.*`), so grep-by-path for the running server misses it;
  use `ss -ltnp | grep :8791` to find the PID, or the process's actual `/tmp/.mount_Nio…/…` path. Kill the node
  web.js PID (parent) + the llama-server PID; the AppImage's `AppRun` `trap cleanup` also fires on signal.
- **`llama-backend.js` `_findBinary()`** must include the AppImage path `usr/lib/llama-cpp/llama-server` (top
  candidate) — without it the model fails to spawn (`ENOENT`) when run from the AppImage. Harmless in folder-run.
- **`deliver_file_to_user` caps at 2 GiB** — Nio.AppImage is 2.6 GB, so move it into place with `mv` (same disk).
- **`realpath -e` / `ls` choke on `..` traversal** — verify path candidates with Node's `existsSync` (the same
  function the code actually calls), not the shell.
