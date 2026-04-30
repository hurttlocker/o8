#!/bin/bash
#
# Engineering Brain — install daily compactor cron (#915 follow-up).
#
# Wires `scripts/compact-facts.ts` into a macOS launchd job that runs every
# day at 3:00 AM. Logs go to ~/.o8/logs/compactor.log. Idempotent: running
# the installer twice replaces the existing plist with the current paths.
#
# Usage:
#   bash scripts/install-compactor-cron.sh           # install / re-install
#   bash scripts/install-compactor-cron.sh remove    # uninstall
#   bash scripts/install-compactor-cron.sh status    # check load state + last run
#   bash scripts/install-compactor-cron.sh run-now   # trigger an immediate run
#
# The job runs even when /Applications/o8.app is closed — the compactor only
# touches the SQLite DB on disk, doesn't need the app running.
#
# This is the dev-workflow path. A future "ship-with-app in-process scheduler"
# (Phase 3, separate issue) will let end-users without npx/tsx get the same
# behavior automatically. For the founder's daily-driver workflow, this is
# enough.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.o8.compactor"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/.o8/logs"
LOG_PATH="$LOG_DIR/compactor.log"
SCRIPT_PATH="${REPO_ROOT}/scripts/compact-facts.ts"

# Resolve npx. We need an absolute path because launchd doesn't inherit the
# user's interactive shell PATH. Try non-interactive shell first (clean
# stdout, no zsh banner pollution), fall back to plain which.
NPX_BIN="$(/bin/sh -c 'command -v npx' 2>/dev/null)"
if [ -z "$NPX_BIN" ]; then
  NPX_BIN="$(which npx 2>/dev/null)"
fi
# Strip any whitespace / banner residue defensively.
NPX_BIN="$(echo "$NPX_BIN" | tail -1 | tr -d '[:space:]')"
if [ -z "$NPX_BIN" ] || [ ! -x "$NPX_BIN" ]; then
  echo "[install-compactor-cron] could not resolve npx (got: '$NPX_BIN') — install Node first" >&2
  exit 1
fi

NODE_BIN="$(dirname "$NPX_BIN")"
PATH_VALUE="${NODE_BIN}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

case "${1:-install}" in
  install)
    if [ ! -f "$SCRIPT_PATH" ]; then
      echo "[install-compactor-cron] compactor not found at $SCRIPT_PATH" >&2
      exit 1
    fi
    mkdir -p "$LOG_DIR"
    mkdir -p "$HOME/Library/LaunchAgents"

    cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${NPX_BIN}</string>
    <string>tsx</string>
    <string>${SCRIPT_PATH}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_ROOT}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${PATH_VALUE}</string>
    <key>HOME</key>
    <string>${HOME}</string>
  </dict>

  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>RunAtLoad</key>
  <false/>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF

    # Replace any prior load (idempotent).
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"

    echo "[install-compactor-cron] installed: ${PLIST_PATH}"
    echo "[install-compactor-cron] schedule: daily @ 3:00 AM"
    echo "[install-compactor-cron] logs:     ${LOG_PATH}"
    echo "[install-compactor-cron] runs:     ${NPX_BIN} tsx ${SCRIPT_PATH}"
    echo ""
    echo "Commands:"
    echo "  bash scripts/install-compactor-cron.sh status   # check load state"
    echo "  bash scripts/install-compactor-cron.sh run-now  # trigger immediately"
    echo "  bash scripts/install-compactor-cron.sh remove   # uninstall"
    ;;

  remove)
    if [ -f "$PLIST_PATH" ]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      echo "[install-compactor-cron] removed: ${PLIST_PATH}"
    else
      echo "[install-compactor-cron] not installed (nothing to do)"
    fi
    ;;

  status)
    if [ ! -f "$PLIST_PATH" ]; then
      echo "[install-compactor-cron] not installed"
      exit 0
    fi
    echo "plist:   ${PLIST_PATH}"
    echo ""
    if launchctl list | grep -q "${LABEL}"; then
      echo "loaded:  yes"
      launchctl list "${LABEL}" 2>&1 | head -25
    else
      echo "loaded:  no — run 'bash scripts/install-compactor-cron.sh install' to load"
    fi
    if [ -f "$LOG_PATH" ]; then
      echo ""
      echo "last 20 lines of ${LOG_PATH}:"
      tail -20 "$LOG_PATH" 2>/dev/null || true
    fi
    ;;

  run-now)
    if [ ! -f "$PLIST_PATH" ]; then
      echo "[install-compactor-cron] not installed — run install first" >&2
      exit 1
    fi
    launchctl start "${LABEL}"
    echo "[install-compactor-cron] triggered ${LABEL}"
    echo "tail logs: tail -f ${LOG_PATH}"
    ;;

  *)
    echo "usage: $0 [install|remove|status|run-now]" >&2
    exit 1
    ;;
esac
