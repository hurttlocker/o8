#!/bin/bash
# Supervised PR-only dogfood launcher. This process owns the single-driver lock,
# the restricted Claude profile, the Git guard, and the app it launches.
set -euo pipefail

SOURCE=${BASH_SOURCE[0]}
while [ -h "$SOURCE" ]; do
  SOURCE_DIR=$(CDPATH='' cd -- "$(dirname -- "$SOURCE")" && pwd -P)
  SOURCE=$(readlink "$SOURCE")
  case "$SOURCE" in /*) ;; *) SOURCE="$SOURCE_DIR/$SOURCE" ;; esac
done
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$SOURCE")" && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$SCRIPT_DIR/../.." && pwd -P)
STATE_DIR="${O8_DOGFOOD_STATE_DIR:-$HOME/.o8}"
APP_BIN="${O8_DOGFOOD_APP_BIN:-/Applications/o8.app/Contents/MacOS/o8}"
CLAUDE_BIN="${O8_DOGFOOD_CLAUDE_BIN:-$(command -v claude 2>/dev/null || true)}"
GATE_BIN="${O8_DOGFOOD_GATE_BIN:-$SCRIPT_DIR/gate.sh}"
REAL_GIT="${O8_DOGFOOD_REAL_GIT:-$(command -v git 2>/dev/null || true)}"
LOCK_DIR="$STATE_DIR/.dogfood.lock"
PR_WALL="$STATE_DIR/.dogfood-pr-only"
STOP_SENTINEL="$STATE_DIR/.dogfood.STOP"
LAUNCHED_PID="$STATE_DIR/.dogfood-launched-pid"
MCP_CONFIG="$LOCK_DIR/mcp.json"
PROMPT_FILE="$SCRIPT_DIR/prompt.md"
HOOKS_DIR="$SCRIPT_DIR/hooks"
MODEL="${O8_DOGFOOD_MODEL:-opus}"
EFFORT="${O8_DOGFOOD_EFFORT:-max}"
LOCK_TOKEN=''
CLAUDE_PID=''

die() { echo "o8 dogfood guard: $*" >&2; exit 70; }

case "$STATE_DIR" in
  /*) ;;
  *) die 'state directory must be an absolute path' ;;
esac
[ "$STATE_DIR" != '/' ] || die 'refusing to use / as the state directory'

process_start() {
  ps -p "$1" -o lstart= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'
}

read_digits_file() {
  [ -f "$1" ] || return 0
  tr -dc '0-9' < "$1"
}

pid_matches_start_file() {
  local pid_file="$1"
  local start_file="$2"
  local pid saved current
  pid=$(read_digits_file "$pid_file")
  saved=$(sed -n '1p' "$start_file" 2>/dev/null || true)
  [ -n "$pid" ] && [ -n "$saved" ] && kill -0 "$pid" 2>/dev/null || return 1
  current=$(process_start "$pid")
  [ -n "$current" ] && [ "$current" = "$saved" ]
}

remove_known_lock_files() {
  [ -d "$LOCK_DIR" ] || return 0
  rm -f "$LOCK_DIR/pid" "$LOCK_DIR/proc-start" "$LOCK_DIR/token" \
    "$LOCK_DIR/claude-pid" "$LOCK_DIR/app-proc-start" "$LOCK_DIR/mcp.json"
  rmdir "$LOCK_DIR" 2>/dev/null || die "lock contains unexpected files: $LOCK_DIR"
}

stop_owned_app() {
  local pid command saved_start current_start
  pid=$(read_digits_file "$LAUNCHED_PID")
  [ -n "$pid" ] || return 0
  command=$(ps -p "$pid" -o command= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  saved_start=$(sed -n '1p' "$LOCK_DIR/app-proc-start" 2>/dev/null || true)
  current_start=$(process_start "$pid")
  if [ "$command" = "$APP_BIN" ] && [ -n "$saved_start" ] && [ "$current_start" = "$saved_start" ]; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
  fi
  rm -f "$LAUNCHED_PID" "$LOCK_DIR/app-proc-start"
}

require_guarded_owner() {
  [ "${O8_DOGFOOD_GUARDED:-}" = '1' ] || die 'app control requires the guarded launcher'
  [ -n "${O8_DOGFOOD_LOCK_TOKEN:-}" ] || die 'app control is missing its lock token'
  [ -f "$LOCK_DIR/token" ] || die 'dogfood lock is not held'
  [ "$(sed -n '1p' "$LOCK_DIR/token")" = "$O8_DOGFOOD_LOCK_TOKEN" ] \
    || die 'dogfood lock belongs to another driver'
}

run_gate() {
  local result
  result=$("$GATE_BIN") || die 'presence gate failed to execute'
  case "$result" in
    ATTENDED|UNATTENDED) printf '%s\n' "$result" ;;
    *) die "presence gate returned an invalid result: $result" ;;
  esac
}

app_start() {
  local gate_result existing pid
  require_guarded_owner
  gate_result=$(run_gate)
  [ "$gate_result" = 'UNATTENDED' ] || { echo 'ATTENDED — app launch refused.' >&2; exit 76; }
  [ -x "$APP_BIN" ] || die "o8 app binary is unavailable: $APP_BIN"

  existing=$(read_digits_file "$LAUNCHED_PID")
  if [ -n "$existing" ] \
    && [ "$(process_start "$existing")" = "$(sed -n '1p' "$LOCK_DIR/app-proc-start" 2>/dev/null || true)" ] \
    && [ "$(ps -p "$existing" -o command= 2>/dev/null | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" = "$APP_BIN" ]; then
    printf 'o8 dogfood app already running at pid %s\n' "$existing"
    return 0
  fi
  rm -f "$LAUNCHED_PID" "$LOCK_DIR/app-proc-start"

  touch "$PR_WALL"
  nohup "$APP_BIN" >> "$STATE_DIR/dogfood-app.log" 2>&1 &
  pid=$!
  printf '%s\n' "$pid" > "$LAUNCHED_PID"
  sleep 1
  kill -0 "$pid" 2>/dev/null || die 'o8 app exited during guarded launch'
  process_start "$pid" > "$LOCK_DIR/app-proc-start"
  [ -s "$LOCK_DIR/app-proc-start" ] || die 'could not fingerprint the guarded o8 app'
  printf 'o8 dogfood app launched at pid %s\n' "$pid"
}

app_stop() {
  local gate_result
  require_guarded_owner
  gate_result=$(run_gate)
  [ "$gate_result" = 'UNATTENDED' ] || { echo 'ATTENDED — owned app left in place.' >&2; exit 76; }
  stop_owned_app
  echo 'o8 dogfood app stopped'
}

stop_loop() {
  local owner_pid claude_pid
  mkdir -p "$STATE_DIR"
  touch "$STOP_SENTINEL"

  stop_owned_app
  claude_pid=$(read_digits_file "$LOCK_DIR/claude-pid")
  [ -z "$claude_pid" ] || kill -TERM "$claude_pid" 2>/dev/null || true

  owner_pid=$(read_digits_file "$LOCK_DIR/pid")
  if pid_matches_start_file "$LOCK_DIR/pid" "$LOCK_DIR/proc-start"; then
    kill -TERM "$owner_pid" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
      kill -0 "$owner_pid" 2>/dev/null || break
      sleep 0.1
    done
  fi

  if ! pid_matches_start_file "$LOCK_DIR/pid" "$LOCK_DIR/proc-start"; then
    rm -f "$PR_WALL"
    remove_known_lock_files
  else
    echo "PR-only wall remains active while owner pid $owner_pid exits." >&2
  fi
  echo "STOP active at $STOP_SENTINEL; remove it explicitly before the next supervised run."
}

acquire_lock() {
  mkdir -p "$STATE_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if pid_matches_start_file "$LOCK_DIR/pid" "$LOCK_DIR/proc-start"; then
      echo "o8 dogfood guard: another driver owns $LOCK_DIR" >&2
      exit 75
    fi
    remove_known_lock_files
    mkdir "$LOCK_DIR" 2>/dev/null || { echo 'o8 dogfood guard: lock acquisition lost a race' >&2; exit 75; }
  fi

  umask 077
  LOCK_TOKEN="$$-$(date +%s)-${RANDOM:-0}"
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
  process_start "$$" > "$LOCK_DIR/proc-start"
  [ -s "$LOCK_DIR/proc-start" ] || die 'could not fingerprint the lock owner'
  printf '%s\n' "$LOCK_TOKEN" > "$LOCK_DIR/token"
  export O8_DOGFOOD_LOCK_TOKEN="$LOCK_TOKEN"
}

release_lock() {
  local held=''
  [ -f "$LOCK_DIR/token" ] && held=$(sed -n '1p' "$LOCK_DIR/token")
  [ -n "$LOCK_TOKEN" ] && [ "$held" = "$LOCK_TOKEN" ] || return 0
  stop_owned_app
  rm -f "$PR_WALL"
  remove_known_lock_files
}

handle_signal() {
  [ -z "$CLAUDE_PID" ] || kill -TERM "$CLAUDE_PID" 2>/dev/null || true
  exit 143
}

write_mcp_config() {
  command -v jq >/dev/null 2>&1 || die 'jq is required to build the restricted MCP profile'
  jq -n --arg server "$REPO_ROOT/src/lib/mcp/operator-mcp-server.ts" \
    --arg state "$STATE_DIR" '{
      mcpServers: {
        o8: {
          command: "npx",
          args: ["tsx", $server],
          env: {
            O8_OPERATOR_MCP_PROFILE: "dogfood",
            O8_DOGFOOD_GUARDED: "1",
            CORTEX_IDE_DATA_DIR: $state
          }
        }
      }
    }' > "$MCP_CONFIG"
  chmod 600 "$MCP_CONFIG"
}

configure_git_guard() {
  [ -n "$REAL_GIT" ] || die 'git is unavailable'
  export O8_DOGFOOD_GUARDED=1
  export O8_DOGFOOD_REAL_GIT="$REAL_GIT"
  export O8_DOGFOOD_HOOKS_DIR="$HOOKS_DIR"
  export O8_DOGFOOD_CONTROL="$SCRIPT_DIR/loop.sh"
  export O8_DOGFOOD_STATE_DIR="$STATE_DIR"
  export O8_DOGFOOD_APP_BIN="$APP_BIN"
  export PATH="$SCRIPT_DIR/bin:$PATH"

  local config_count="${GIT_CONFIG_COUNT:-0}"
  case "$config_count" in *[!0-9]*) die 'GIT_CONFIG_COUNT must be numeric' ;; esac
  export "GIT_CONFIG_KEY_$config_count=core.hooksPath"
  export "GIT_CONFIG_VALUE_$config_count=$HOOKS_DIR"
  export GIT_CONFIG_COUNT=$((config_count + 1))
}

check_profile() {
  printf 'repo=%s\n' "$REPO_ROOT"
  printf 'state=%s\n' "$STATE_DIR"
  printf 'gate=%s\n' "$(run_gate)"
  printf 'native_tools=%s\n' 'Read,Edit,Write,Bash,Glob,Grep,WebFetch,WebSearch,Agent'
  printf 'mcp_profile=%s\n' 'dogfood'
  printf 'git_guard=%s\n' "$HOOKS_DIR/pre-push"
}

case "${1:-}" in
  gate) run_gate; exit 0 ;;
  app-start) app_start; exit 0 ;;
  app-stop) app_stop; exit 0 ;;
  queue-sync) exec "$SCRIPT_DIR/queue-sync.sh" ;;
  --stop|stop) stop_loop; exit 0 ;;
  --check|check) check_profile; exit 0 ;;
  '') ;;
  *) die "unknown argument: $1" ;;
esac

[ -n "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] || die 'claude is unavailable'
[ -f "$PROMPT_FILE" ] || die "dogfood prompt is unavailable: $PROMPT_FILE"
[ -x "$GATE_BIN" ] || die "presence gate is unavailable: $GATE_BIN"
[ ! -f "$STOP_SENTINEL" ] || die "kill switch is active: $STOP_SENTINEL"
[ "$(run_gate)" = 'UNATTENDED' ] || { echo 'ATTENDED — dogfood launcher is standing down.' >&2; exit 76; }

acquire_lock
trap release_lock EXIT
trap handle_signal INT TERM HUP
touch "$PR_WALL"
configure_git_guard
write_mcp_config

cd "$REPO_ROOT"
"$CLAUDE_BIN" \
  --dangerously-skip-permissions \
  --strict-mcp-config \
  --mcp-config "$MCP_CONFIG" \
  --settings '{"disableAllHooks":true}' \
  --setting-sources project \
  --disable-slash-commands \
  --tools 'Read,Edit,Write,Bash,Glob,Grep,WebFetch,WebSearch,Agent' \
  --disallowedTools TaskCreate TaskUpdate TaskList TaskGet TaskStop TeamCreate TeamDelete SendMessage EnterPlanMode ExitPlanMode \
  --append-system-prompt-file "$PROMPT_FILE" \
  --model "$MODEL" \
  --effort "$EFFORT" &
CLAUDE_PID=$!
printf '%s\n' "$CLAUDE_PID" > "$LOCK_DIR/claude-pid"
set +e
wait "$CLAUDE_PID"
status=$?
set -e
CLAUDE_PID=''
exit "$status"
