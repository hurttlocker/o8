#!/usr/bin/env bash
set -euo pipefail

# Local fallback for .github/workflows/sync-changelog.yml while the CI account
# is suspended for billing. Generates the sanitized o8 changelog + stats, then
# pushes to hurttlocker/o8-releases. Logic mirrors the workflow — when updating
# one, update the other.

WORK_DIR="${WORK_DIR:-/tmp/o8-changelog-sync}"
OUT_CHANGELOG="$WORK_DIR/CHANGELOG.md"
OUT_STATS="$WORK_DIR/STATS.md"
PUBLIC_CLONE="$WORK_DIR/o8"
SINCE="180 days ago"

rm -rf "$WORK_DIR" "$PUBLIC_CLONE"
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

  # --- Strategy / budget / model drop list ---
  # Drop entire entries that reveal monetization plans, specific model choices,
  # perf/token/cost budget numbers, or dogfood-specific tooling. These give a
  # reader too much of our playbook. Losing a handful of entries is fine —
  # the public changelog is for feature visibility, not architecture reveals.
  if echo "$msg" | grep -qiE 'monetization|monetiz|pricing|paywall|freemium|subscription|revenue|waitlist|gtm|go-to-market|moat'; then continue; fi
  if echo "$msg" | grep -qiE '\bopus\b|\bsonnet\b|\bhaiku\b|\bgpt-?[0-9.]+\b|\bo[134]-preview\b|xhigh|low.reason|high.reason|reasoning.effort|thinking.effort|chain.of.thought|thinking.x-?ray'; then continue; fi
  if echo "$msg" | grep -qiE '\b[0-9]{2,4}\s*ms\b.*budget|\b[0-9]+\s*mb\b.*budget|\b[0-9]+.line.ceiling|\b800.line|budget|ceiling|line.cap|file.size.limit|token.budget|context.budget'; then continue; fi
  if echo "$msg" | grep -qiE 'dogfood|dogfed'; then continue; fi

  # --- Path + infra + arch-detail scrubs ---
  # Internal paths reveal our data-dir layout. Architecture-detail phrases
  # reveal our internal system design at a level a competitor could copy.
  msg=$(echo "$msg" | sed -E \
    -e 's#~/\.o8[a-zA-Z0-9._-]*#the user data dir#g' \
    -e 's#~/\.cortex[a-zA-Z0-9._-]*#the user data dir#g' \
    -e 's/lane (governance|review transition|lifecycle|reconcile)/workflow transition/gi' \
    -e 's/verb=merge/workflow action/gi' \
    -e 's/approve_and_merge/workflow action/gi' \
    -e 's/rule-check/governance check/gi' \
    -e 's/supervisor (watch|fleet|completion)/workflow watcher/gi')

  msg=$(echo "$msg" | sed -E \
    -e 's/Cortex IDE/o8/gi' \
    -e 's/Cortex-aware/context-aware/gi' \
    -e 's/CortexClient/client/gi' \
    -e 's/\.cortexrules/project rules/gi' \
    -e 's/Cortex ?[Mm]emory/memory/gi' \
    -e 's/Cortex/o8/gi' \
    -e 's/Rainwater/o8/gi' \
    -e 's/Symon/voice agent/gi' \
    -e 's/Hurttlocker/design system/gi' \
    -e 's/aqua-color/the voice stack/gi' \
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

  # [via-o8] attribution: preserve an existing marker through the scrubs, and
  # backfill unmarked PR squash merges whose head branch was a packet branch
  # (issue/* / inline/*) — those merged through o8's dispatch loop too.
  via_o8=""
  if echo "$msg" | grep -qE '\[via-o8\]\s*$'; then
    via_o8="yes"
    msg=$(echo "$msg" | sed -E 's/ *\[via-o8\] *//g')
  else
    pr_num=$(echo "$msg" | grep -oE '\(#[0-9]+\)\s*$' | grep -oE '[0-9]+' || true)
    if [ -n "$pr_num" ]; then
      head_ref=$(gh api "repos/hurttlocker/o8/pulls/$pr_num" --jq .head.ref 2>/dev/null || true)
      case "$head_ref" in issue/*|inline/*) via_o8="yes";; esac
    fi
  fi

  msg=$(echo "$msg" | sed -E 's/ *\(#[0-9]+\)//g; s/ *#[0-9]+//g')
  msg=$(echo "$msg" | sed -E 's/ — .{40,}//g')
  msg=$(echo "$msg" | sed -E 's/ (of|for|via|from|with|in|the) *$//')
  if [ -n "$via_o8" ]; then msg="$msg [via-o8]"; fi

  if [ "$date" != "$current_date" ]; then
    printf '\n## %s\n\n' "$date" >> "$OUT_CHANGELOG"
    current_date="$date"
  fi
  # %%s for literal - then space + entry. Single-quoted printf fmt avoids
  # backslash-escape surprises on different shells.
  printf '%s\n' "- \`$hash\` $msg" >> "$OUT_CHANGELOG"
done

# Blocklist check
BLOCKLIST=(Cortex Rainwater Symon Hurttlocker aqua-color OpenClaw NemoClaw PicoClaw Codex opencode Tauri Drizzle better-sqlite tmux Anthropic Claude Gemini GPT-4 GPT-5 Opus Sonnet Haiku xhigh BYOK Cursor Conductor monetization "API key" cortexrules CortexClient ".cortex" ".o8-ide")
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
  echo "| Merged through o8 (180d) | $(git log --since='180 days ago' --format='%s' --no-merges | grep -c '\[via-o8\]' || echo 0) |"
  echo "| Days active | $(git log --format='%as' | sort -u | wc -l | tr -d ' ') |"
  echo "| This week | $(git log --since='7 days ago' --format='%s' --no-merges | grep -cE '^(feat|perf|design)(\(.*\))?:' || echo 0) features |"
  echo "| Today | $(git log --since='1 day ago' --format='%s' --no-merges | grep -cE '^(feat|perf|design)(\(.*\))?:' || echo 0) features |"
} > "$OUT_STATS"

# Push to Rainwater
gh repo clone hurttlocker/o8-releases "$PUBLIC_CLONE" -- --depth 1
cp "$OUT_CHANGELOG" "$PUBLIC_CLONE/CHANGELOG.md"
cp "$OUT_STATS" "$PUBLIC_CLONE/STATS.md"
rm -f "$PUBLIC_CLONE/ROADMAP.md"

cd "$PUBLIC_CLONE"
git add -A
if git diff --cached --quiet; then
  echo "[sync] No changes — public mirror already up to date"
else
  git commit -m "sync: Update changelog $(date -u +%Y-%m-%d)"
  git push
  echo "[sync] Pushed clean changelog to hurttlocker/o8-releases"
fi
