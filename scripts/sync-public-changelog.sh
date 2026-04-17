#!/usr/bin/env bash
set -euo pipefail

# Local fallback for .github/workflows/sync-changelog.yml while the CI account
# is suspended for billing. Generates the sanitized o8 changelog + stats, then
# pushes to hurttlocker/Rainwater. Logic mirrors the workflow — when updating
# one, update the other.

WORK_DIR="${WORK_DIR:-/tmp/o8-changelog-sync}"
OUT_CHANGELOG="$WORK_DIR/CHANGELOG.md"
OUT_STATS="$WORK_DIR/STATS.md"
RAINWATER_CLONE="$WORK_DIR/Rainwater"
SINCE="180 days ago"

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

cat > "$OUT_CHANGELOG" << 'HEADER'
# Changelog

Development activity for o8 — the governance layer for autonomous engineering teams.

We ship high-signal entries only (features + performance wins). Bug fixes, refactors,
and internal chores live in the private engineering log.

---
HEADER

current_date=""
git log --since="$SINCE" --format="%as|%h|%s" --no-merges | while IFS='|' read -r date hash msg; do
  if ! echo "$msg" | grep -qE '^(feat|perf|design)(\(.*\))?:'; then continue; fi
  if echo "$msg" | grep -qiE '^Revert'; then continue; fi
  if echo "$msg" | grep -qiE '^auto-commit'; then continue; fi
  if echo "$msg" | grep -qiE 'injection|race.condition|vulnerability|xss|csrf|exploit|CVE|credential|password'; then continue; fi

  msg=$(echo "$msg" | sed -E \
    -e 's/Cortex IDE/o8/gi' \
    -e 's/Cortex-aware/context-aware/gi' \
    -e 's/CortexClient/client/gi' \
    -e 's/\.cortexrules/project rules/gi' \
    -e 's/Cortex ?[Mm]emory/memory/gi' \
    -e 's/Cortex/o8/gi' \
    -e 's/Rainwater/o8/gi' \
    -e 's/OpenClaw/agent runtime/gi' \
    -e 's/NemoClaw/agent runtime/gi' \
    -e 's/PicoClaw/bundled runtime/gi' \
    -e 's/Codex/agent runtime/gi' \
    -e 's/Claude Code/agent runtime/gi' \
    -e 's/opencode/agent runtime/gi' \
    -e 's/Tauri/native shell/gi' \
    -e 's/Drizzle/ORM/gi' \
    -e 's/better-sqlite3?/database/gi' \
    -e 's/Gemini/AI provider/gi' \
    -e 's/CLAUDE\.md/project rules/g' \
    -e 's/Claude/AI provider/gi' \
    -e 's/Anthropic/AI provider/gi' \
    -e 's/GPT-?[0-9.]*/AI model/gi' \
    -e 's/Cursor/competing product/gi' \
    -e 's/Conductor/competing product/gi' \
    -e 's/API [Kk]ey[s]?/configuration/gi' \
    -e 's/BYOK/bring-your-own/gi' \
    -e 's/tmux/terminal/gi')

  msg=$(echo "$msg" | sed -E 's/ *\(#[0-9]+\)//g; s/ *#[0-9]+//g')
  msg=$(echo "$msg" | sed -E 's/ — .{40,}//g')
  msg=$(echo "$msg" | sed -E 's/ (of|for|via|from|with|in|the) *$//')

  if [ "$date" != "$current_date" ]; then
    printf '\n## %s\n\n' "$date" >> "$OUT_CHANGELOG"
    current_date="$date"
  fi
  # %%s for literal - then space + entry. Single-quoted printf fmt avoids
  # backslash-escape surprises on different shells.
  printf '%s\n' "- \`$hash\` $msg" >> "$OUT_CHANGELOG"
done

# Blocklist check
BLOCKLIST=(Cortex Rainwater OpenClaw NemoClaw PicoClaw Codex opencode Tauri Drizzle better-sqlite tmux Anthropic Claude Gemini GPT-4 GPT-5 BYOK Cursor Conductor "API key" cortexrules CortexClient ".cortex")
LEAKED=""
for term in "${BLOCKLIST[@]}"; do
  if grep -qi "$term" "$OUT_CHANGELOG"; then
    LEAKED="$LEAKED\n  - '$term'"
  fi
done
if [ -n "$LEAKED" ]; then
  echo "BLOCKED — internal terms found in public changelog:$LEAKED" >&2
  exit 1
fi
echo "[sync] Blocklist check passed"

# Stats
{
  echo "# Development Stats"
  echo ""
  echo "Last updated: $(date -u +%Y-%m-%d)"
  echo ""
  echo "| Metric | Value |"
  echo "|---|---|"
  echo "| Features shipped (180d) | $(git log --since='180 days ago' --format='%s' --no-merges | grep -cE '^(feat|perf|design)(\(.*\))?:' || echo 0) |"
  echo "| Days active | $(git log --format='%as' | sort -u | wc -l | tr -d ' ') |"
  echo "| This week | $(git log --since='7 days ago' --format='%s' --no-merges | grep -cE '^(feat|perf|design)(\(.*\))?:' || echo 0) features |"
  echo "| Today | $(git log --since='1 day ago' --format='%s' --no-merges | grep -cE '^(feat|perf|design)(\(.*\))?:' || echo 0) features |"
} > "$OUT_STATS"

# Push to Rainwater
gh repo clone hurttlocker/Rainwater "$RAINWATER_CLONE" -- --depth 1
cp "$OUT_CHANGELOG" "$RAINWATER_CLONE/CHANGELOG.md"
cp "$OUT_STATS" "$RAINWATER_CLONE/STATS.md"
rm -f "$RAINWATER_CLONE/ROADMAP.md"

cd "$RAINWATER_CLONE"
git add -A
if git diff --cached --quiet; then
  echo "[sync] No changes — Rainwater already up to date"
else
  git commit -m "sync: Update changelog $(date -u +%Y-%m-%d)"
  git push
  echo "[sync] Pushed clean changelog to hurttlocker/Rainwater"
fi
