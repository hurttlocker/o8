#!/bin/bash
#
# Engineering Brain — install weekly digest cron (#970 phase 2).
#
# Wires `scripts/weekly-brain-digest.sh` into a macOS launchd job that runs
# every Monday at 8:00 AM. The wrapper runs the fact compactor with
# --digest-to, writes the markdown digest to ~/.o8/digests/, fires a
# native notification, and opens the file.
#
# This is the SIBLING of install-compactor-cron.sh (daily 3 AM compaction
# without delivery). Both can be installed at the same time — they're
# distinct launchd labels.
#
# Usage:
#   bash scripts/install-compactor-digest-cron.sh           # install / re-install
#   bash scripts/install-compactor-digest-cron.sh remove    # uninstall
#   bash scripts/install-compactor-digest-cron.sh status    # check load state
#   bash scripts/install-compactor-digest-cron.sh run-now   # trigger an immediate run
#
# Logs go to ~/.o8/logs/brain-digest.log.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.o8.compactor-digest"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="$HOME/.o8/logs"
LOG_PATH="$LOG_DIR/brain-digest.log"
WRAPPER_PATH="${REPO_ROOT}/scripts/weekly-brain-digest.sh"

# Resolve npx so PATH inside launchd has Node tools.
NPX_BIN="$(/bin/sh -c 'command -v npx' 2>/dev/null)"
if [ -z "$NPX_BIN" ]; then
  NPX_BIN="$(which npx 2>/dev/null)"
fi
NPX_BIN="$(echo "$NPX_BIN" | tail -1 | tr -d '[:space:]')"
if [ -z "$NPX_BIN" ] || [ ! -x "$NPX_BIN" ]; then
  echo "[install-compactor-digest-cron] could not resolve npx — install Node first" >&2
  exit 1
fi

NODE_BIN="$(dirname "$NPX_BIN")"
PATH_VALUE="${NODE_BIN}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

case "${1:-install}" in
  install)
    if [ ! -f "$WRAPPER_PATH" ]; then
      echo "[install-compactor-digest-cron] wrapper not found at $WRAPPER_PATH" >&2
      exit 1
    fi
    if [ ! -x "$WRAPPER_PATH" ]; then
      chmod +x "$WRAPPER_PATH"
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
    <string>/bin/bash</string>
    <string>${WRAPPER_PATH}</string>
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
    <key>Weekday</key>
    <integer>1</integer>
    <key>Hour</key>
    <integer>8</integer>
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

    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    launchctl load "$PLIST_PATH"

    echo "[install-compactor-digest-cron] installed: ${PLIST_PATH}"
    echo "[install-compactor-digest-cron] schedule: Monday @ 8:00 AM"
    echo "[install-compactor-digest-cron] logs:     ${LOG_PATH}"
    echo "[install-compactor-digest-cron] runs:     bash ${WRAPPER_PATH}"
    echo ""
    echo "Commands:"
    echo "  bash scripts/install-compactor-digest-cron.sh status   # check load state"
    echo "  bash scripts/install-compactor-digest-cron.sh run-now  # trigger immediately"
    echo "  bash scripts/install-compactor-digest-cron.sh remove   # uninstall"
    ;;

  remove)
    if [ -f "$PLIST_PATH" ]; then
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm -f "$PLIST_PATH"
      echo "[install-compactor-digest-cron] removed: ${PLIST_PATH}"
    else
      echo "[install-compactor-digest-cron] not installed (nothing to do)"
    fi
    ;;

  status)
    if [ ! -f "$PLIST_PATH" ]; then
      echo "[install-compactor-digest-cron] not installed"
      exit 0
    fi
    echo "plist:   ${PLIST_PATH}"
    echo ""
    if launchctl list | grep -q "${LABEL}"; then
      echo "loaded:  yes"
      launchctl list "${LABEL}" 2>&1 | head -25
    else
      echo "loaded:  no — run 'bash scripts/install-compactor-digest-cron.sh install' to load"
    fi
    if [ -f "$LOG_PATH" ]; then
      echo ""
      echo "last 20 lines of ${LOG_PATH}:"
      tail -20 "$LOG_PATH" 2>/dev/null || true
    fi
    ;;

  run-now)
    if [ ! -f "$PLIST_PATH" ]; then
      echo "[install-compactor-digest-cron] not installed — run install first" >&2
      exit 1
    fi
    launchctl start "${LABEL}"
    echo "[install-compactor-digest-cron] triggered ${LABEL}"
    echo "tail logs: tail -f ${LOG_PATH}"
    ;;

  *)
    echo "usage: $0 [install|remove|status|run-now]" >&2
    exit 1
    ;;
esac
