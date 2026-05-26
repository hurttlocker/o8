#!/bin/bash
#
# Engineering Brain — weekly digest delivery wrapper (#970 phase 2).
#
# Runs the fact compactor with --digest-to writing a chat-ready markdown
# digest into ~/.o8/digests/, then fires a macOS native notification so
# the founder sees "Brain digest ready" on Monday morning.
#
# Invoked by the launchd plist installed via
# `bash scripts/install-compactor-digest-cron.sh`. Can also be run by hand:
#   bash scripts/weekly-brain-digest.sh           # full run + notify
#   bash scripts/weekly-brain-digest.sh --dry-run # digest only, no DB writes
#
# Logs go to ~/.o8/logs/brain-digest.log.
#
# In-chat injection (the original ask in #970) is a deferred follow-up that
# needs a new system-message type in the orchestrator chat transcript.
# For now the macOS notification + opening the markdown file is the
# delivery surface.

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIGESTS_DIR="$HOME/.o8/digests"
LOG_DIR="$HOME/.o8/logs"
LOG_PATH="$LOG_DIR/brain-digest.log"
COMPACT_SCRIPT="${REPO_ROOT}/scripts/compact-facts.ts"

mkdir -p "$DIGESTS_DIR"
mkdir -p "$LOG_DIR"

STAMP="$(date +%Y-%m-%d)"
DIGEST_PATH="${DIGESTS_DIR}/brain-${STAMP}.md"

# Resolve npx the same way install-compactor-cron.sh does — launchd
# doesn't inherit the user's shell PATH.
NPX_BIN="$(/bin/sh -c 'command -v npx' 2>/dev/null)"
if [ -z "$NPX_BIN" ]; then
  NPX_BIN="$(which npx 2>/dev/null)"
fi
NPX_BIN="$(echo "$NPX_BIN" | tail -1 | tr -d '[:space:]')"
if [ -z "$NPX_BIN" ] || [ ! -x "$NPX_BIN" ]; then
  echo "[weekly-brain-digest] could not resolve npx" >&2
  exit 1
fi

# Forward any caller flags (e.g. --dry-run) to the compactor.
EXTRA_ARGS=("$@")

echo "[weekly-brain-digest] running compactor, digest → ${DIGEST_PATH}"
"$NPX_BIN" tsx "$COMPACT_SCRIPT" --digest-to="$DIGEST_PATH" "${EXTRA_ARGS[@]}"

if [ ! -f "$DIGEST_PATH" ]; then
  echo "[weekly-brain-digest] digest file not created — skipping notification" >&2
  exit 1
fi

# macOS native notification. The osascript path is the lowest-friction
# delivery surface — no app dependency, fires whether o8.app is running
# or not. Falls through silently if osascript isn't available (CI / Linux).
if command -v osascript >/dev/null 2>&1; then
  osascript -e "display notification \"Weekly Brain digest ready — ${STAMP}\" with title \"o8 Compactor\" subtitle \"Click to open digest\"" 2>/dev/null || true
fi

# Open the digest in the default markdown viewer. macOS `open` defaults
# to TextEdit unless the user has a markdown editor set. Skip on
# headless / non-mac systems.
if command -v open >/dev/null 2>&1; then
  open "$DIGEST_PATH" 2>/dev/null || true
fi

echo "[weekly-brain-digest] done — ${DIGEST_PATH}"
