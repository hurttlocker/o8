#!/usr/bin/env bash
# T3 — multi-runtime parallel dispatch (#940)
#
# PIVOT (2026-04-30): the founder's framing called for codex + gemini +
# opencode parallel, but gemini and opencode silently fail to launch in
# this environment due to env-var auth gaps:
#   - opencode default model 'opencode/gpt-5-nano' requires OPENAI auth
#     (only XAI + GOOGLE keys present)
#   - gemini in --output-format stream-json requires GEMINI_API_KEY (user
#     has GOOGLE_GENERATIVE_AI_API_KEY but not the GEMINI_-prefixed alias)
# These are runtime-adapter bugs, surfaced as separate findings in the
# REPORT. For T3 we run codex-only — homogeneous parallel vs serial — to
# isolate the question "does o8's parallelism reduce wall-clock?"
# Heterogeneous-runtime parallel is gated on the adapter fixes.
#
# Tasks: 2 small independent file-creation tasks against /Users/marquisehurtt/o8-test-sandbox.
# Run A: sequential=true (wave 1 → wave 2). Run B: sequential=false (both wave 1).

set -euo pipefail

API=http://127.0.0.1:3001
TOKEN=$(cat ~/.cortex-ide/ws-token)
H_AUTH="Authorization: Bearer ${TOKEN}"
H_JSON="Content-Type: application/json"
SANDBOX=/Users/marquisehurtt/o8-test-sandbox
DB=~/.o8/cortex-ide.db
STATE=~/.o8/orchestrator-state.json
DATA_DIR=/Users/marquisehurtt/o8-validation/tests/epic-937/t3-parallel/data
TIMEOUT_SEC=240

mkdir -p "$DATA_DIR"

# ── Helpers ─────────────────────────────────────────────────────────────────

backup_state() {
  local label="$1"
  local out="$DATA_DIR/orchestrator-state.backup-${label}-$(date +%s).json"
  cp "$STATE" "$out"
  echo "$out"
}

cleanup_sandbox_lanes() {
  sqlite3 "$DB" "UPDATE lanes SET status='archived', updated_at=datetime('now'), last_event_label='t3-cleanup' WHERE repo_path = '$SANDBOX' AND status != 'archived';" || true
}

kill_sandbox_clis() {
  node -e '
    const { execSync } = require("child_process");
    const out = execSync("ps -axo pid,command", { encoding: "utf8" });
    const sandbox = "/Users/marquisehurtt/o8-test-sandbox";
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const cmd = m[2];
      if (pid === process.pid) continue;
      if (!/(codex|gemini|opencode)/.test(cmd)) continue;
      if (!cmd.includes(sandbox)) continue;
      try { process.kill(pid, "SIGTERM"); console.log("[t3] term", pid); }
      catch (e) {}
    }
  '
}

mission_status_json() {
  curl -fsS -m 8 "$API/api/orchestrator/status" -H "$H_AUTH" 2>&1 || echo '{"error":"fetch failed"}'
}

count_completed_packets() {
  mission_status_json | jq '[.result.packets[] | select(.status == "awaiting_review" or .status == "released" or .status == "archived")] | length' 2>/dev/null || echo "0"
}

cleanup_sandbox_worktrees() {
  set +e
  pushd "$SANDBOX" >/dev/null 2>&1 || { set -e; return 0; }
  local wt_list
  wt_list=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep -v "^$SANDBOX$")
  if [ -n "$wt_list" ]; then
    while IFS= read -r wt; do
      [ -n "$wt" ] && git worktree remove --force "$wt" 2>/dev/null
    done <<< "$wt_list"
  fi
  local br_list
  br_list=$(git branch 2>/dev/null | sed 's/^\*//' | awk '{print $1}' | grep -v "^main$")
  if [ -n "$br_list" ]; then
    while IFS= read -r br; do
      [ -n "$br" ] && git branch -D "$br" 2>/dev/null
    done <<< "$br_list"
  fi
  popd >/dev/null 2>&1
  set -e
}

# ── Run A: SERIAL ───────────────────────────────────────────────────────────

run_serial() {
  echo "=========================================="
  echo "[t3] === RUN A — SERIAL (codex, sequential=true, 2 packets) ==="
  echo "=========================================="
  cleanup_sandbox_worktrees
  local backup_a; backup_a=$(backup_state "runA")
  echo "[t3-A] backup: $backup_a"

  local start_a; start_a=$(date +%s)
  local resp_a
  resp_a=$(curl -fsS -m 30 -X POST "$API/api/orchestrator/create-mission" \
    -H "$H_AUTH" -H "$H_JSON" \
    -d '{
      "repoPath": "/Users/marquisehurtt/o8-test-sandbox",
      "runtime": "codex",
      "sequential": true,
      "issues": [
        {"number": 90001, "title": "t3 serial 1", "body": "Create file_s1.txt at the repo root with content: serial task 1 done. Then commit it with a one-line commit message."},
        {"number": 90002, "title": "t3 serial 2", "body": "Create file_s2.txt at the repo root with content: serial task 2 done. Then commit it with a one-line commit message."}
      ]
    }')
  echo "[t3-A] resp: $resp_a"
  local mid_a; mid_a=$(echo "$resp_a" | jq -r '.result.missionId')

  echo "[t3-A] polling for completion (timeout ${TIMEOUT_SEC}s)..."
  local elapsed=0 last_count=-1
  while [ $elapsed -lt $TIMEOUT_SEC ]; do
    local count; count=$(count_completed_packets)
    if [ "$count" != "$last_count" ]; then
      echo "[t3-A] t+${elapsed}s — completed=$count/2"
      last_count=$count
    fi
    if [ "$count" = "2" ]; then break; fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  local end_a; end_a=$(date +%s)
  local wall_a=$((end_a - start_a))
  local final_count_a; final_count_a=$(count_completed_packets)
  echo "[t3-A] FINAL: completed=$final_count_a/2 wall_clock=${wall_a}s"
  echo "[t3-A] lanes:"
  sqlite3 -header -column "$DB" "SELECT id, runtime, status, packet_id FROM lanes WHERE repo_path = '$SANDBOX' ORDER BY created_at;"

  echo "[t3-A] cleanup"
  kill_sandbox_clis
  cleanup_sandbox_lanes
  cp "$backup_a" "$STATE"
  cleanup_sandbox_worktrees

  echo "{ \"run\": \"A_serial\", \"missionId\": \"$mid_a\", \"start\": $start_a, \"end\": $end_a, \"wall_clock_sec\": $wall_a, \"completed\": $final_count_a, \"target_count\": 2, \"runtime\": \"codex\", \"mode\": \"sequential=true\" }" > "$DATA_DIR/runA.json"
}

# ── Run B: PARALLEL ─────────────────────────────────────────────────────────

run_parallel() {
  echo "=========================================="
  echo "[t3] === RUN B — PARALLEL (codex, sequential=false, 2 packets) ==="
  echo "=========================================="
  cleanup_sandbox_worktrees
  local backup_b; backup_b=$(backup_state "runB")
  echo "[t3-B] backup: $backup_b"

  local start_b; start_b=$(date +%s)
  local resp_b
  resp_b=$(curl -fsS -m 30 -X POST "$API/api/orchestrator/create-mission" \
    -H "$H_AUTH" -H "$H_JSON" \
    -d '{
      "repoPath": "/Users/marquisehurtt/o8-test-sandbox",
      "runtime": "codex",
      "sequential": false,
      "issues": [
        {"number": 90011, "title": "t3 parallel A", "body": "Create file_pA.txt at the repo root with content: parallel task A done. Then commit it with a one-line commit message."},
        {"number": 90012, "title": "t3 parallel B", "body": "Create file_pB.txt at the repo root with content: parallel task B done. Then commit it with a one-line commit message."}
      ]
    }')
  echo "[t3-B] resp: $resp_b"
  local mid_b; mid_b=$(echo "$resp_b" | jq -r '.result.missionId')

  echo "[t3-B] polling for completion (timeout ${TIMEOUT_SEC}s)..."
  local elapsed=0 last_count=-1
  while [ $elapsed -lt $TIMEOUT_SEC ]; do
    local count; count=$(count_completed_packets)
    if [ "$count" != "$last_count" ]; then
      echo "[t3-B] t+${elapsed}s — completed=$count/2"
      last_count=$count
    fi
    if [ "$count" = "2" ]; then break; fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  local end_b; end_b=$(date +%s)
  local wall_b=$((end_b - start_b))
  local final_count_b; final_count_b=$(count_completed_packets)
  echo "[t3-B] FINAL: completed=$final_count_b/2 wall_clock=${wall_b}s"
  echo "[t3-B] lanes:"
  sqlite3 -header -column "$DB" "SELECT id, runtime, status, packet_id FROM lanes WHERE repo_path = '$SANDBOX' ORDER BY created_at;"

  echo "[t3-B] cleanup"
  kill_sandbox_clis
  cleanup_sandbox_lanes
  cp "$backup_b" "$STATE"
  cleanup_sandbox_worktrees

  echo "{ \"run\": \"B_parallel\", \"missionId\": \"$mid_b\", \"start\": $start_b, \"end\": $end_b, \"wall_clock_sec\": $wall_b, \"completed\": $final_count_b, \"target_count\": 2, \"runtime\": \"codex\", \"mode\": \"sequential=false\" }" > "$DATA_DIR/runB.json"
}

# ── Main ────────────────────────────────────────────────────────────────────

echo "[t3] === START ==="
run_serial
sleep 5
run_parallel
echo "[t3] === COMPLETE ==="
echo "[t3] runA.json: $(cat $DATA_DIR/runA.json)"
echo "[t3] runB.json: $(cat $DATA_DIR/runB.json)"
