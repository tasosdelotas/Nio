#!/bin/bash
# Nio installer: puts the app in ~/Nio and installs the launcher.
# Run it from anywhere — the extracted zip folder, a git clone, wherever.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Nio"

running_app_pids() {
  local proc pid arg
  local -a argv
  for proc in /proc/[0-9]*; do
    [ -r "$proc/cmdline" ] || continue
    argv=()
    mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || true
    for arg in "${argv[@]}"; do
      # Match BOTH forms: the nio launcher runs `node web.js` with a RELATIVE
      # path (after cd-ing into the app dir), so argv holds "web.js", not the
      # absolute $DEST/web.js. For the relative form, confirm the process's CWD
      # is $DEST — otherwise we'd match an unrelated `node web.js` elsewhere.
      if [ "$arg" = "$DEST/web.js" ]; then
        pid="${proc##*/}"
        printf '%s\n' "$pid"
        break
      fi
      if [ "$arg" = "web.js" ] && [ -d "$proc/cwd" ] && [ "$(readlink -f "$proc/cwd" 2>/dev/null)" = "$DEST" ]; then
        pid="${proc##*/}"
        printf '%s\n' "$pid"
        break
      fi
    done
  done
}

stop_running_app() {
  local pid attempt
  local -a pids
  mapfile -t pids < <(running_app_pids)
  [ "${#pids[@]}" -gt 0 ] || return 0
  echo "Stopping the running Nio app before replacing its files..."
  for pid in "${pids[@]}"; do
    if ! kill "$pid" 2>/dev/null; then
      echo "ERROR: could not stop Nio (PID $pid); no app files were replaced." >&2
      exit 1
    fi
  done
  for attempt in {1..20}; do
    mapfile -t pids < <(running_app_pids)
    [ "${#pids[@]}" -eq 0 ] && return 0
    sleep 0.25
  done
  echo "ERROR: Nio is still running; close it and retry. No app files were replaced." >&2
  exit 1
}

# ── Prerequisite: Nio's OWN bundled Node (18+) — no system Node is used ──
# Nio is 100% self-contained: it ships Node in the 'node/' folder and runs on
# that binary only. The installer therefore REQUIRES the bundled Node and never
# falls back to a system-wide node (that fallback was a leftover from when Nio
# borrowed LM Studio's Node).
node_path=""
if [ -x "$DIR/node/bin/node" ]; then
  node_path="$DIR/node/bin/node"
elif [ -d "$DIR/node-v"*"-linux-x64" ]; then
  for c in "$DIR"/node-v*-linux-x64/bin/node; do
    [ -x "$c" ] && node_path="$c" && break
  done
fi
if [ -z "$node_path" ]; then
  echo
  echo "ERROR: Nio's bundled Node.js was not found."
  echo "Nio must include its own Node in the 'node/' folder (node/bin/node)."
  echo "(Nio does NOT use a system Node.js — that is by design.)"
  echo
  echo "Fix: download a Node.js 18+ linux-x64 build from https://nodejs.org/, extract it,"
  echo "and place the extracted folder as './node' inside the Nio source folder."
  exit 1
fi

node_version="$("$node_path" --version 2>/dev/null || echo v0.0.0)"
node_major="${node_version#v}"
node_major="${node_major%%.*}"
case "$node_major" in ''|*[!0-9]*) node_major=0 ;; esac

if [ "$node_major" -lt 18 ]; then
  echo
  echo "ERROR: bundled Node.js is $node_version, but Nio needs 18 or newer."
  echo
  echo "Replace the bundled Node: download Node.js 18+ (linux-x64) from https://nodejs.org/,"
  echo "extract it, and put the folder in place as './node' inside the Nio source folder."
  exit 1
fi

echo "Node.js $node_version found - OK."

# ── Version check (optional enhancement) ────────────────────────────────────
if [ "$DIR" != "$DEST" ] && [ -f "$DEST/package.json" ]; then
  SRC_VER=$("$node_path" -e "console.log(JSON.parse(require('fs').readFileSync('$DIR/package.json','utf8')).version)" 2>/dev/null || echo "unknown")
  DST_VER=$("$node_path" -e "console.log(JSON.parse(require('fs').readFileSync('$DEST/package.json','utf8')).version)" 2>/dev/null || echo "none")
  if [ "$SRC_VER" != "$DST_VER" ]; then
    echo "Installing $SRC_VER over $DST_VER"
  fi
fi

# ── Copy application files ──────────────────────────────────────────────────
# install.sh is the LOCAL TEST installer (end users run the AppImage, which bakes
# its own model in). So every run is a FRESH CLEAN INSTALL: wipe $DEST and re-copy
# the ENTIRE source tree — code AND the bundled model. No data preservation here;
# "clean" means clean. (This is why the old --exclude='./models' is gone: it left
# a fresh install with an EMPTY models folder, so Nio had no brain to load.)
if [ "$DIR" != "$DEST" ]; then
  stop_running_app

  # The source must actually ship a model — otherwise a "clean install" would
  # silently produce a Nio with no brain. Fail loudly instead.
  if ! find "$DIR/models" -name '*.gguf' 2>/dev/null | grep -q .; then
    echo "ERROR: no .gguf model found in $DIR/models — a clean install needs the bundled model."
    echo "       Put the GGUF directly in models/ (e.g. models/Nio.gguf) and re-run."
    exit 1
  fi

  # Wipe the previous install completely, then copy the whole tree fresh.
  if [ -d "$DEST" ]; then
    echo "Fresh clean install: removing existing $DEST ..."
    rm -rf "$DEST"
  fi
  mkdir -p "$DEST"

  # Copy everything (code + models + config). Skipped: .git (not part of a
  # runnable install), fine-tune/ (dev-only training recipe, never installed),
  # .gitignore (dev-only), and the private project docs BUILD.md / HANDOFF.md /
  # VOICE-BIBLE.md (internal — they're gitignored for the same reason). The
  # model is included on purpose.
  tar -C "$DIR" \
      --exclude='./.git' \
      --exclude='./fine-tune' \
      --exclude='./.gitignore' \
      --exclude='./BUILD.md' \
      --exclude='./HANDOFF.md' \
      --exclude='./VOICE-BIBLE.md' \
      -cf - . | tar -C "$DEST" -xf -

  chmod +x "$DEST/nio" "$DEST/install.sh" "$DEST/uninstall.sh" 2>/dev/null || true

  # Flatten the model: Nio keeps its brain as a flat models/*.gguf (matches what
  # the AppImage settles on first run). If the source ever ships it in a
  # subfolder again, move it up so the layout is always flat.
  for gguf in "$DEST"/models/*/*.gguf; do
    [ -f "$gguf" ] || continue
    mv -f "$gguf" "$DEST/models/"
  done
  find "$DEST/models" -mindepth 1 -type d -empty -delete 2>/dev/null || true

  # llama-server lives at llama-cpp/llama-server (flat, current) or llama-cpp/bin/llama-server
  # (older bin/ layout) — make whichever is present executable, and drop the now-obsolete
  # empty bin/ dir the old layout left behind.
  if [ -f "$DEST/llama-cpp/llama-server" ]; then
    chmod +x "$DEST/llama-cpp/llama-server"
  elif [ -f "$DEST/llama-cpp/bin/llama-server" ]; then
    chmod +x "$DEST/llama-cpp/bin/llama-server"
  elif [ -f "$DEST/bin/llama-server" ]; then
    chmod +x "$DEST/bin/llama-server"
  fi

  mkdir -p "$DEST/models"

  # A clean install always copies a FRESH config.json from source (the tar above),
  # so there is nothing to preserve or merge — just lock the permissions down.
  if [ ! -f "$DEST/config.json" ]; then
    echo "ERROR: $DEST/config.json missing after copy — the source must include config.json."
    exit 1
  fi
  chmod 600 "$DEST/config.json" 2>/dev/null || true

  # ── Fresh-install notice + integrity check ─────────────────────────────
  # This is always a clean install now, so say so plainly (old chats/memory are
  # gone by design) and verify the core files AND the model all made it across.
  echo ""
  echo "✓ Fresh clean install complete (previous data was removed)."
  if find "$DEST/models" -name '*.gguf' 2>/dev/null | grep -q .; then
    echo "  • Model installed: $(find "$DEST/models" -name '*.gguf' 2>/dev/null | head -1)"
  else
    echo "  • WARNING: no model found in $DEST/models — Nio will have nothing to load."
  fi
  # Everything web.js reads at module load / boot — a half-broken copy must be
  # caught HERE, not as an opaque crash on first launch.
  for REQUIRED in web.js agent.js llama-backend.js sessions.js user-memory.js nio config.json system-prompt.md web/index.html web/live-tts.js; do
    if [ ! -f "$DEST/$REQUIRED" ]; then
      echo "ERROR: $DEST/$REQUIRED is missing after install — the copy may be incomplete."
      echo "       Re-run from the source folder:  bash $DIR/install.sh"
      exit 1
    fi
  done
  # The bundled Node must be present and runnable (Nio never uses system Node).
  if [ ! -x "$DEST/node/bin/node" ]; then
    echo "ERROR: bundled Node ($DEST/node/bin/node) is missing after install."
    echo "       The source folder must include a 'node/' folder. Re-run:  bash $DIR/install.sh"
    exit 1
  fi

  echo "App installed to: $DEST (source folder left untouched: $DIR)"

  if ! bash "$DEST/install.sh"; then
    echo ""
    echo "NOTE: Files were copied to $DEST, but the final setup step failed."
    echo "Re-run from the source folder to retry:  bash $DIR/install.sh"
    exit 1
  fi
  exit 0
fi

# ── Desktop Entries (Runs when DIR == DEST) ─────────────────────────────────
[ -f "$DIR/web.js" ] || { echo "ERROR: app not found in $DIR"; exit 1; }

DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
  DESKTOP_DIR="$HOME/Desktop"
fi

EXEC_PATH="$DEST/nio"
ICON_PATH="$DEST/nio.png"

if [ ! -x "$EXEC_PATH" ]; then
  echo "WARNING: $EXEC_PATH not executable — desktop entry may fail" >&2
fi

if [ ! -f "$ICON_PATH" ]; then
  echo "WARNING: $ICON_PATH not found — icon will be missing from launcher" >&2
  ICON_PATH=""
fi

# ── Register the icon in the hicolor theme under the exact WM_CLASS name ──
# KDE/GNOME match a window's WM_CLASS ("nio", set by the launcher's
# --class=nio) against an icon *name*. Without an icon literally named
# "nio" in the theme, the taskbar falls back to a generic placeholder.
if [ -n "$ICON_PATH" ] && [ -f "$ICON_PATH" ]; then
  HC_ICON_DIR="$HOME/.local/share/icons/hicolor"
  # KDE/KWin want CRISP SQUARE icons in the fixed-size taskbar + title-bar slots.
  # The blurry-icon bug came from TWO mistakes, fixed here:
  #   1. Padding: a fit-to-square WITH transparent padding leaves a small statue in
  #      a big box → soft at 16-24px. We want the statue to FILL the square.
  #   2. "-resize px" (no !) only shrinks-to-fit → tiny statue in a transparent box.
  # The master is 1144x858, so an exact px×px resample ("!") just shrinks it —
  # no crop, no padding box, head fully intact at every size.
  # Single source now: generate from the master nio.png (the 256px appicon was
  # removed — the master downscales fine and is the one icon we maintain).
  APPICON_SRC="$ICON_PATH"

  for px in 16 22 24 32 48 64 128 256 512; do
    mkdir -p "$HC_ICON_DIR/${px}x${px}/apps"
    if command -v convert >/dev/null 2>&1; then
      # Exact px×px render ("!" forces it), Lanczos anti-aliased. The source already
      # fills the square, so this just resamples crisply — no padding box, no head crop.
      convert "$APPICON_SRC" -resize ${px}x${px}! -filter Lanczos \
        -define png:color-type=6 \
        "$HC_ICON_DIR/${px}x${px}/apps/nio.png" 2>/dev/null \
        || cp "$APPICON_SRC" "$HC_ICON_DIR/${px}x${px}/apps/nio.png"
    else
      cp "$APPICON_SRC" "$HC_ICON_DIR/${px}x${px}/apps/nio.png"
    fi
  done
  gtk-update-icon-cache "$HC_ICON_DIR" >/dev/null 2>&1 || true
  # Bust any stale desktop icon caches so the WM picks up the new icon
  # immediately (KDE's icon-cache.kcache, GTK's per-size caches, etc.).
  rm -f "$HOME/.cache/icon-cache.kcache" 2>/dev/null || true
  find "$HOME/.cache" -maxdepth 2 -name 'icon-cache.*' -delete 2>/dev/null || true
  echo "Icon registered in hicolor theme as square 'nio' icons (caches refreshed)."
fi

if [ -d "$DESKTOP_DIR" ]; then
  cat > "$DESKTOP_DIR/nio.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Nio
Comment=Nio — your local AI friend
Exec=$EXEC_PATH
$([ -n "$ICON_PATH" ] && echo "Icon=$ICON_PATH")
Terminal=false
Categories=Development;Network;Utility;
StartupWMClass=nio
EOF
  chmod +x "$DESKTOP_DIR/nio.desktop"
  gio set "$DESKTOP_DIR/nio.desktop" metadata::trusted true 2>/dev/null || true
  echo "Desktop launcher installed: $DESKTOP_DIR/nio.desktop"
else
  echo "NOTE: no desktop folder found."
fi

if [ -d "$HOME/.local/share/applications" ]; then
  cat > "$HOME/.local/share/applications/nio.desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=Nio
Comment=Nio — your local AI friend
Exec=$EXEC_PATH
$([ -n "$ICON_PATH" ] && echo "Icon=$ICON_PATH")
Terminal=false
Categories=Development;Network;Utility;
StartupWMClass=nio
EOF
  chmod +x "$HOME/.local/share/applications/nio.desktop"
  if command -v desktop-file-validate >/dev/null 2>&1; then
    if ! desktop-file-validate "$HOME/.local/share/applications/nio.desktop" 2>/dev/null; then
      echo "WARNING: desktop entry validation failed"
    fi
  fi
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
  echo "App menu entry installed."
fi

echo "Done. Start Nio with: $DIR/nio"

if command -v notify-send >/dev/null 2>&1; then
  if [ -n "$ICON_PATH" ]; then
    notify-send "Nio Installation Complete" \
                "Nio has been installed successfully! Click the Nio icon to start." \
                --icon="$ICON_PATH"
  else
    notify-send "Nio Installation Complete" \
                "Nio has been installed successfully! Click the Nio icon to start."
  fi
fi