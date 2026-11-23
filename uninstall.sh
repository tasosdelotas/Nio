#!/bin/bash
# Nio uninstaller: stops the server and removes the app and all its traces.
set -euo pipefail

[ -n "${HOME:-}" ] || { echo "Error: HOME is not set." >&2; exit 1; }

# Resolve the data dir the SAME way web.js does (NIO_HOME first, then ~/Nio).
# If NIO_HOME pointed elsewhere, the user's memory/sessions/models live THERE —
# deleting only ~/Nio and saying "completely removed" would be a lie.
APP="$HOME/Nio"
if [ -n "${NIO_HOME:-}" ]; then
  DATA_DIR="$NIO_HOME"
else
  DATA_DIR="$HOME/Nio"
fi

# ── Confirmation dialog (GUI when double-clicked, terminal when run from CLI) ──
# GUI only when a display actually exists — zenity on an SSH/headless box exits
# non-zero, which used to read as "Cancel" and made uninstall IMPOSSIBLE there.
HAVE_DISPLAY=false
if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then HAVE_DISPLAY=true; fi

confirmed=false
if $HAVE_DISPLAY && command -v zenity >/dev/null 2>&1; then
  if zenity --question \
    --title="Uninstall Nio" \
    --text="This will PERMANENTLY delete:
• All chat history (sessions.json)
• Your profile (memory.md)
• Downloaded models
• Custom settings
This cannot be undone." \
    --ok-label="Yes, uninstall" \
    --cancel-label="Cancel" \
    --width=400 2>/dev/null; then
    confirmed=true
  fi
elif $HAVE_DISPLAY && command -v kdialog >/dev/null 2>&1; then
  if kdialog --yesno "This will PERMANENTLY delete all Nio data including chat history, memory, downloaded models, and settings.
This cannot be undone.
Continue?" \
    --title "Uninstall Nio" 2>/dev/null; then
    confirmed=true
  fi
else
  # Terminal fallback
  echo "⚠️  WARNING: This will completely remove Nio and ALL your data, including:"
  echo "   - Your chat history (sessions.json)"
  echo "   - Your profile (memory.md)"
  echo "   - Your custom settings and downloaded models"
  echo ""
  # || true: at EOF (e.g. `bash uninstall.sh < /dev/null`) read fails and would
  # otherwise trip set -e with a silent exit instead of "cancelled".
  confirm=""
  read -r -p "Are you sure you want to uninstall Nio? [y/N] " confirm || true
  if [[ "$confirm" =~ ^[Yy]([Ee][Ss])?$ ]]; then   # accept y, Y, yes, Yes
    confirmed=true
  fi
fi

if [ "$confirmed" != "true" ]; then
  echo "Uninstallation cancelled."
  exit 0
fi

echo "Uninstalling Nio..."

# A PID is only ours if its /proc cmdline actually runs web.js from our app dir.
# (Stale pid files are the NORMAL state — web.js auto-exits after the last tab
# closes — and after a reboot the number can belong to an unrelated process.)
pid_is_nio() {
  local pid="$1"
  [ -n "$pid" ] && [ "$pid" -gt 0 ] 2>/dev/null || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  local arg
  [ -r "/proc/$pid/cmdline" ] || return 1
  while IFS= read -r -d '' arg; do
    if [ "$arg" = "web.js" ]; then
      [ -d "/proc/$pid/cwd" ] && [ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" = "$APP" ] && return 0
    fi
  done < "/proc/$pid/cmdline"
  return 1
}

stop_nio_pid() {
  local pid="$1"
  pid_is_nio "$pid" || return 0
  kill "$pid" 2>/dev/null || true        # SIGTERM: web.js stops llama-server gracefully
  for _ in {1..20}; do                   # up to ~5s grace before escalating
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.25
  done
  kill -9 "$pid" 2>/dev/null || true
}

echo "Stopping any running Nio processes..."
# PID file first (the launcher writes it; web.js removes it on exit).
if [ -f "$DATA_DIR/server.pid" ]; then
  stop_nio_pid "$(cat "$DATA_DIR/server.pid" 2>/dev/null || true)"
fi
# Scan for the rest. The old `pgrep -f "$APP/web\.js"` NEVER matched Nio — the
# launcher's argv is `node web.js` (relative, after Round 14: absolute $PWD/web.js,
# which this still misses when cwd differs) — but it COULD match bystanders
# (vim/tail/grep on that path). Scan /proc like install.sh does instead.
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  arg_found=""
  while IFS= read -r -d '' a; do [ "$a" = "web.js" ] && arg_found=1 && break; done < "$proc/cmdline" 2>/dev/null || true
  if [ -n "$arg_found" ]; then
    if [ -d "$proc/cwd" ] && [ "$(readlink -f "$proc/cwd" 2>/dev/null)" = "$APP" ]; then
      stop_nio_pid "${proc##*/}"
    fi
  fi
done

# 1b) The llama-server child. web.js's SIGTERM handler kills it — but if node
# died without cleanup (crash, OOM, old build), the orphan survives: holding
# ~2.5–3 GB RAM, port 8091, AND the mmap'd GGUF (so df shows no freed space
# until it dies) — and it poisons a reinstall by answering /health on 8091.
# _findBinary() returns an ABSOLUTE path, so argv[0] contains it → pkill -f is safe.
echo "Stopping any orphaned llama-server..."
for pat in "$APP/llama-cpp/llama-server" "$APP/llama-cpp/bin/llama-server" "$APP/bin/llama-server" \
           "$DATA_DIR/llama-cpp/llama-server" "$DATA_DIR/llama-cpp/bin/llama-server"; do
  pkill -TERM -f "$pat" 2>/dev/null || true
done
sleep 1
for pat in "$APP/llama-cpp/llama-server" "$APP/llama-cpp/bin/llama-server" "$APP/bin/llama-server" \
           "$DATA_DIR/llama-cpp/llama-server" "$DATA_DIR/llama-cpp/bin/llama-server"; do
  pkill -KILL -f "$pat" 2>/dev/null || true
done

# 2) Desktop icon + app menu entry (handles non-English locales)
echo "Removing desktop shortcuts..."
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
  DESKTOP_DIR="$HOME/Desktop"
fi
rm -f "$DESKTOP_DIR/nio.desktop"
rm -f "$HOME/.local/share/applications/nio.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

# 3) hicolor theme icons — install.sh writes nine nio.png files (16…512px)
#    and refreshes the caches; removing only the .desktop entries left all of
#    them plus stale cache entries behind.
echo "Removing theme icons..."
HC_ICON_DIR="$HOME/.local/share/icons/hicolor"
for px in 16 22 24 32 48 64 128 256 512; do
  rm -f "$HC_ICON_DIR/${px}x${px}/apps/nio.png"
done
gtk-update-icon-cache "$HC_ICON_DIR" >/dev/null 2>&1 || true
rm -f "$HOME/.cache/icon-cache.kcache" 2>/dev/null || true
find "$HOME/.cache" -maxdepth 2 -name 'icon-cache.*' -delete 2>/dev/null || true

# 4) The app itself (code, config, persona) — sanity-checked first: this is an
#    rm -rf, so only run it on a folder that actually looks like Nio.
echo "Removing application files..."
if [ -f "$APP/web.js" ]; then
  rm -rf "$APP"
else
  echo "Note: $APP does not look like a Nio install (no web.js) — left in place."
fi
# User data may live elsewhere when NIO_HOME was set — remove it too.
if [ "$DATA_DIR" != "$APP" ] && [ -d "$DATA_DIR" ]; then
  echo "Removing user data at $DATA_DIR (NIO_HOME)..."
  if [ -f "$DATA_DIR/sessions.json" ] || [ -f "$DATA_DIR/memory.md" ] || [ -d "$DATA_DIR/models" ]; then
    rm -rf "$DATA_DIR"
  else
    echo "Note: $DATA_DIR does not look like Nio data — left in place."
  fi
fi

# Show completion notification
# The AppImage itself (the README's uninstall instruction names it) — only when
# we can find one sitting next to this script or on the Desktop.
for img in "$(dirname "$0")/Nio.AppImage" "$HOME/Desktop/Nio.AppImage"; do
  [ -f "$img" ] && { echo "Removing $img..."; rm -f "$img"; }
done

if command -v notify-send >/dev/null 2>&1; then
  notify-send "Nio Uninstalled" "Nio has been completely removed from your system."
fi

echo "✓ Nio has been completely uninstalled."
echo "  (Note: voice/TTS settings saved in your browser's profile remain — clear the"
echo "   site data for http://127.0.0.1:8791 in your browser if you want those gone too.)"
