#!/bin/bash
# Pull open `dogfood` issues into the loop queue without importing issue bodies.
set -euo pipefail

STATE_DIR="${O8_DOGFOOD_STATE_DIR:-$HOME/.o8}"
QUEUE="$STATE_DIR/dogfood-queue.json"
HANDLED="$STATE_DIR/feedback-handled.json"
REPO="${O8_DOGFOOD_REPO:-hurttlocker/o8}"
TMP="$QUEUE.tmp.$$"

mkdir -p "$STATE_DIR"
[ -f "$QUEUE" ] || printf '[]\n' > "$QUEUE"
[ -f "$HANDLED" ] || printf '{}\n' > "$HANDLED"
trap 'rm -f "$TMP"' EXIT

issues=$(gh issue list --repo "$REPO" --label dogfood --state open --json number,title,url --limit 50)
jq --argjson issues "$issues" --slurpfile handled "$HANDLED" '
  ($handled[0] // {}) as $done
  | map(.id) as $have
  | . + [ $issues[]
          | ("gh-" + (.number|tostring)) as $iid
          | select(($have | index($iid)) == null and ($done[$iid] == null))
          | { id: $iid, source: "github", lead: .title, ref: .url, priority: 0 } ]
' "$QUEUE" > "$TMP"
mv "$TMP" "$QUEUE"
trap - EXIT

count=$(jq 'length' "$QUEUE")
echo "queue ($QUEUE) now has $count item(s):"
jq -r '.[] | "  [p\(.priority)] \(.id) — \(.lead)"' "$QUEUE"
