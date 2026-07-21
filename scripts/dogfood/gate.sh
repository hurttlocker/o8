#!/bin/bash
# Fail-safe presence gate for the supervised o8 dogfood loop (#1173).
# stdout is intentionally one word so callers cannot misread diagnostics.
set +e

say() { echo "$1"; exit 0; }

STATE_DIR="${O8_DOGFOOD_STATE_DIR:-$HOME/.o8}"
APP_BIN="${O8_DOGFOOD_APP_BIN:-/Applications/o8.app/Contents/MacOS/o8}"
HEARTBEAT="$STATE_DIR/attended.heartbeat"
LAUNCHED_PID="$STATE_DIR/.dogfood-launched-pid"

command -v pgrep >/dev/null 2>&1 || say ATTENDED
command -v stat >/dev/null 2>&1 || say ATTENDED
command -v find >/dev/null 2>&1 || say ATTENDED
command -v ps >/dev/null 2>&1 || say ATTENDED

# The operator's kill switch always wins.
[ -f "$STATE_DIR/.dogfood.STOP" ] && say ATTENDED

# A fresh focused-window heartbeat proves an operator is in o8.
if [ -f "$HEARTBEAT" ]; then
  now=$(date +%s) || say ATTENDED
  modified=$(stat -f %m "$HEARTBEAT" 2>/dev/null)
  if [ -z "$modified" ]; then
    modified=$(stat -c %Y "$HEARTBEAT" 2>/dev/null)
  fi
  [ -n "$modified" ] || say ATTENDED
  [ $((now - modified)) -lt 600 ] && say ATTENDED
fi

# Ignore only the exact app PID launched through the guarded wrapper. Any
# second o8 process is an operator arrival and forces the loop to stand down.
loop_pid=0
if [ -f "$LAUNCHED_PID" ]; then
  candidate=$(tr -dc '0-9' < "$LAUNCHED_PID")
  saved_start=$(sed -n '1p' "$STATE_DIR/.dogfood.lock/app-proc-start" 2>/dev/null)
  current_start=$(ps -p "${candidate:-0}" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  if [ -n "$candidate" ] && [ -n "$saved_start" ] && [ "$current_start" = "$saved_start" ]; then
    loop_pid=$candidate
  fi
fi
for pid in $(pgrep -fx "$APP_BIN" 2>/dev/null); do
  [ "$pid" != "$loop_pid" ] && say ATTENDED
done

# A recent in-app orchestrator message is also positive presence evidence.
if [ -d "$STATE_DIR/chat-history" ]; then
  recent=$(find "$STATE_DIR/chat-history" -name 'thoughts-*.json' -mmin -15 -print -quit 2>/dev/null)
  [ -n "$recent" ] && say ATTENDED
fi

say UNATTENDED
