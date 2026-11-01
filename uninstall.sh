#!/bin/bash
# Nio uninstaller: stops the server and removes the app and all its traces.
set -euo pipefail

APP="$HOME/Nio"
# Data lives inside ~/Nio alongside the app
DATA_DIR="$HOME/Nio"

# ── Confirmation dialog (GUI when double-clicked, terminal when run from CLI) ──
confirmed=false
if command -v zenity >/dev/null 2>&1; then
  if zenity --question \
    --title="Uninstall Nio" \
    --text="This will PERMANENTLY delete:
• All chat history (sessions.json)
• AI memory (memory.json)
• Downloaded models
• Custom settings
This cannot be undone." \
    --ok-label="Yes, uninstall" \
    --cancel-label="Cancel" \
    --width=400 2>/dev/null; then
    confirmed=true
  fi
elif command -v kdialog >/dev/null 2>&1; then
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
  echo "   - Your AI's long-term memory (memory.json)"
  echo "   - Your custom settings and downloaded models"
  echo ""
  read -p "Are you sure you want to uninstall Nio? [y/N] " confirm
  if [[ "$confirm" =~ ^[Yy]$ ]]; then
    confirmed=true
  fi
fi

if [ "$confirmed" != "true" ]; then
  echo "Uninstallation cancelled."
  exit 0
fi

echo "Uninstalling Nio..."

# 1) Stop a running server started from this app dir
echo "Stopping any running Nio processes..."
pids=$(pgrep -f "$APP/web\.js" 2>/dev/null || true)
if [ -n "$pids" ]; then
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  sleep 1
  pids=$(pgrep -f "$APP/web\.js" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    for pid in $pids; do kill -9 "$pid" 2>/dev/null || true; done
  fi
fi

# Also kill via PID file if the launcher created one
if [ -f "$DATA_DIR/server.pid" ]; then
  pid=$(cat "$DATA_DIR/server.pid" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    kill -9 "$pid" 2>/dev/null || true
  fi
fi

# 2) Desktop icon + app menu entry (handles non-English locales)
echo "Removing desktop shortcuts..."
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
  DESKTOP_DIR="$HOME/Desktop"
fi
rm -f "$DESKTOP_DIR/nio.desktop"
rm -f "$HOME/.local/share/applications/nio.desktop"
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

# 3) Stray launcher logs and state
echo "Cleaning up temporary files..."
rm -f /tmp/nio-server.log
rm -f /tmp/nio.log

# 4) The app itself (config, persona, code, downloaded models, sessions, memory)
#    Since DATA_DIR == APP, this single rm -rf removes everything.
echo "Removing application files and all user data..."
rm -rf "$APP"

# Show completion notification
if command -v notify-send >/dev/null 2>&1; then
  notify-send "Nio Uninstalled" "Nio has been completely removed from your system."
fi

echo "✓ Nio has been completely uninstalled."
