# Nio — AppImage build recipe

> **How to (re)package Nio into the single `Nio.AppImage`.**
> Reproduced on 2026-11-01 from a working build. Follow this top-to-bottom and you get a
> correct, verified `Nio.AppImage`. The only "magic" is the layout — the AppImage is just
> an AppDir (a folder) squashed into a type-2 AppImage runtime.

## What the AppImage contains (the layout — keep this exact)

```
Nio.AppImage  (type-2: ELF runtime + squashfs)
└─ AppDir/
   ├─ AppRun            ← the "being" launcher (see ./AppRun in this folder)
   ├─ nio.png           ← the 512 icon (from ./nio.png)
   ├─ .DirIcon → nio.png
   ├─ NIO.desktop       ← desktop entry (Name=Nio, Icon=nio)
   └─ usr/
      ├─ bin/           (empty)
      ├─ lib/
      │   ├─ node/        ← bundled Node   (copy of ./node)
      │   └─ llama-cpp/   ← bundled llama.cpp (copy of ./llama-cpp)
      ├─ share/
      │   ├─ appimage/io.nio.appimage   (runtime id, optional)
      │   ├─ applications/nio.desktop
      │   ├─ icons/hicolor/{16,22,24,32,48,64,128,256,512}/apps/nio.png  (crisp taskbar set)
      │   └─ nio/         ← THE APP  (this is what web.js runs from)
      │       ├─ web.js agent.js sessions.js llama-backend.js memory.js user-memory.js
      │       ├─ config.json package.json nio.png   ← nio.png MUST be here (web.js serves /nio.png from __dirname)
      │       ├─ tools/   web/
      │       └─ models/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf   ← the brain (embedded, ~1.2 GB)
```

Key facts:
- **App code runs from `usr/share/nio/`**, with **Node at `usr/lib/node`** and **llama.cpp at `usr/lib/llama-cpp`**.
- `AppRun` boots `usr/lib/node/bin/node web.js` (cwd = `usr/share/nio`) and settles the model
  into `~/Nio/models/` on first run (one-time, ~1.2 GB).
- **`llama-backend.js` `_findBinary()` MUST list the AppImage path** `usr/lib/llama-cpp/llama-server`
  (it does, as the top candidate). Without it the model fails to spawn (`ENOENT`) from the AppImage.
  Keep that candidate if you ever touch `_findBinary`.
- **Nio has NO version** — do not add a version badge, `NIO_VERSION`, or in-app updates back in.

## Tools needed (one-time install)

```bash
sudo apt-get install -y squashfs-tools                 # mksquashfs / unsquashfs
# AppImage runtime/tool (type-2, x86_64). Downloads to wherever you run it:
curl -L -o appimagetool.AppImage \
  https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x appimagetool.AppImage
```

## Build steps

1. **Assemble the AppDir** (layout above). Copy the *current, clean* source into `usr/share/nio`,
   the bundled runtimes into `usr/lib/{node,llama-cpp}`, drop the model into
   `usr/share/nio/models/...`, and place `./AppRun`, `./nio.png`, the `.desktop`, and the hicolor icons.
   Exclude stale/backup files (e.g. `web/favicon-transparent.bak-*`).
2. **Build:**
   ```bash
   ./appimagetool.AppImage <path-to-AppDir> Nio.AppImage
   ```
   (Name the output exactly `Nio.AppImage` — not versioned.)
3. **Verify (do not skip):**
   - `Nio.AppImage --appimage-extract` → check the AppDir is clean (no `image-input.js`, no `.bak` dirs).
   - Boot it: wait for `GET http://127.0.0.1:8791/api/backend` → `"state":"ready"`.
   - Real send: `POST /send` with `{"text":"Reply with exactly: hello"}` → Nio should answer.
   - UI: `GET /` → `<title>Nio</title>`, solid red bubble present, Help button present, **no version string**,
     `/live-tts.js`, `/nio-avatar.png`, `/marble.jpeg` all 200.
4. **Clean up:** kill the AppImage's `node web.js` + `llama-server` PIDs (it runs from a FUSE mount
   `/tmp/.mount_Nio.*`; find PIDs with `ss -ltnp | grep -E ':8791|:8091'`).
5. **Ship:** the final location is **`/home/tasos/Labor/Nio.AppImage`** (now ~1.6 GB, so the
   `deliver_file_to_user` 2 GiB cap is no longer a problem; still `mv` if same-disk).

## One-liner build script (run from this folder)

```bash
set -euo pipefail
cd "$(dirname "$0")"
B="$(mktemp -d)/NIO.AppDir"; NIO="$B/usr/share/nio"
mkdir -p "$B/usr/lib" "$B/usr/bin" "$B/usr/share/appimage" "$B/usr/share/applications" \
         "$B/usr/share/icons/hicolor" "$NIO"
cp -a node "$B/usr/lib/node"; cp -a llama-cpp "$B/usr/lib/llama-cpp"
cp -a web.js agent.js sessions.js llama-backend.js memory.js user-memory.js \
      config.json package.json nio.png "$NIO/"
cp -a tools "$NIO/tools"; mkdir -p "$NIO/web"
for f in web/*; do bn=$(basename "$f"); [ "$bn" = "favicon-transparent.bak-20261030" ] && continue; cp -a "$f" "$NIO/web/"; done
mkdir -p "$NIO/models/Qwen3.5-2B-GGUF"
cp -a models/Qwen3.5-2B-GGUF/Qwen3.5-2B-Q4_K_M.gguf "$NIO/models/Qwen3.5-2B-GGUF/"
cp AppRun "$B/AppRun"; chmod +x "$B/AppRun"
cp nio.png "$B/nio.png"; ln -sf nio.png "$B/.DirIcon"
printf '[Desktop Entry]\nType=Application\nName=Nio\nGenericName=Your local AI friend\nComment=Nio — a warm, local, private AI friend. One file, one friend, no cloud.\nExec=nio\nIcon=nio\nTerminal=false\nCategories=Utility;\n' > "$B/NIO.desktop"
cp "$B/NIO.desktop" "$B/usr/share/applications/nio.desktop"
printf 'io.nio.appimage\n' > "$B/usr/share/appimage/io.nio.appimage"
for sz in 16 22 24 32 48 64 128 256 512; do d="$B/usr/share/icons/hicolor/${sz}x${sz}/apps"; mkdir -p "$d"; cp nio.png "$d/nio.png"; done
./appimagetool.AppImage "$B" Nio.AppImage
```

## Gotchas (learned the hard way)
- **`/nio.png` must be inside `usr/share/nio/`, not just the AppDir root.** web.js serves it from
  `__dirname` (`usr/share/nio`), so if you only put `nio.png` at the AppDir top level the page favicon
  404s in the AppImage (title bar shows no icon). The one-liner below copies it into `"$NIO/"` — keep that.
- **`realpath -e` / `ls` choke on `..`** — verify binary-path candidates with Node's `existsSync`
  (the same function `_findBinary` calls), not the shell.
- **`pkill -f` matching the shell's own command line self-kills the shell** — kill by PID instead.
- The AppImage runs from a **FUSE mount**, so grep-by-source-path misses the running server; use the port.
- Keep the **model** in `~/Nio/models/` for fast repeat tests — AppRun only copies it on first run, so
  subsequent boots are instant.
- The build is fast (~10 s to compress ~1.6 GB with squashfs; the copy is the slow part).
