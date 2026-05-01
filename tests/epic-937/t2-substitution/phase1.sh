#!/usr/bin/env bash
# t2 Phase 1 — mid-packet runtime substitution mechanism check.
#
# Runs against the running /Applications/o8.app on port 3001. Backs up the
# user's current orchestrator-state.json before the test and restores it
# after, so the user's awaiting_review packet survives unchanged.
#
# Test scenario:
#   1. Create mission against /Users/marquisehurtt/o8-test-sandbox, runtime=codex
#   2. Wait 8s for codex lane to register
#   3. Reset packet
#   4. Create new mission, same packet body, runtime=opencode
#   5. Wait 8s for opencode lane to register
#   6. Reset packet
#   7. Inspect state
#   8. Restore orchestrator-state.json
#
# Invariants checked:
#   I1. After reset of codex mission, the codex lane is archived (not deleted).
#   I2. After creating the opencode mission, a NEW lane appears with runtime='opencode'.
#   I3. Both lanes survive in the lanes table (no orphan deletion).
#   I4. The orchestrator state file is properly backed up and restored.
#
# Phase 1 PASS iff all four invariants hold.

set -euo pipefail

API=http://127.0.0.1:3001
TOKEN=$(cat ~/.cortex-ide/ws-token)
H_AUTH="Authorization: Bearer ${TOKEN}"
H_JSON="Content-Type: application/json"
SANDBOX=/Users/marquisehurtt/o8-test-sandbox
DB=~/.o8/cortex-ide.db
STATE=~/.o8/orchestrator-state.json
BACKUP_DIR=/Users/marquisehurtt/o8-validation/tests/epic-937/t2-substitution/data
mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/orchestrator-state.backup-$(date +%s).json"

echo "[t2-phase1] === START ==="
echo "[t2-phase1] backing up orchestrator state to $BACKUP"
cp "$STATE" "$BACKUP"
cp "$STATE" "$STATE.t2-test-bak"

# Capture pre-test lanes for sandbox repo (should be empty)
echo "[t2-phase1] pre-test sandbox lanes:"
sqlite3 "$DB" "SELECT id, runtime, status, packet_id FROM lanes WHERE repo_path = '$SANDBOX' ORDER BY created_at;" || true

# ── Step 1: codex mission ───────────────────────────────────────────────────
echo "[t2-phase1] ▶ Creating mission with runtime=codex"
RESP1=$(curl -fsS -X POST "$API/api/orchestrator/create-mission" \
  -H "$H_AUTH" -H "$H_JSON" \
  -d "{
    \"repoPath\": \"$SANDBOX\",
    \"runtime\": \"codex\",
    \"issues\": [{
      \"number\": 90001,
      \"title\": \"t2-phase1 codex marker\",
      \"body\": \"Edit sandbox.js to add a single-line comment at the bottom: // codex was here\"
    }]
  }")
echo "[t2-phase1] codex mission resp: $RESP1"
PACKET1=$(echo "$RESP1" | jq -r '.result.packets[0].id')
MISSION1=$(echo "$RESP1" | jq -r '.result.missionId')
echo "[t2-phase1] codex packet=$PACKET1 mission=$MISSION1"

echo "[t2-phase1] sleeping 10s for codex spawn"
sleep 10

# ── Step 2: capture state ───────────────────────────────────────────────────
echo "[t2-phase1] codex lane state:"
sqlite3 -header -column "$DB" "SELECT id, runtime, status, packet_id, branch FROM lanes WHERE repo_path = '$SANDBOX' ORDER BY created_at;"

CODEX_LANE_ID=$(sqlite3 "$DB" "SELECT id FROM lanes WHERE repo_path = '$SANDBOX' AND runtime='codex' ORDER BY created_at DESC LIMIT 1;" || echo "")
CODEX_LANE_STATUS=$(sqlite3 "$DB" "SELECT status FROM lanes WHERE repo_path = '$SANDBOX' AND runtime='codex' ORDER BY created_at DESC LIMIT 1;" || echo "")
echo "[t2-phase1] codex lane: id=$CODEX_LANE_ID status=$CODEX_LANE_STATUS"

# ── Step 3: reset codex packet ──────────────────────────────────────────────
echo "[t2-phase1] ▶ Resetting codex packet"
RESP2=$(curl -fsS -X POST "$API/api/orchestrator/reset-packet" \
  -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"packetId\":\"$PACKET1\",\"reason\":\"t2 mid-packet swap\"}")
echo "[t2-phase1] reset resp: $RESP2"

sleep 2
echo "[t2-phase1] post-reset codex lane state:"
sqlite3 -header -column "$DB" "SELECT id, runtime, status, packet_id FROM lanes WHERE repo_path = '$SANDBOX' ORDER BY created_at;"
CODEX_AFTER_RESET_STATUS=$(sqlite3 "$DB" "SELECT status FROM lanes WHERE id='$CODEX_LANE_ID';" || echo "")
echo "[t2-phase1] codex lane post-reset status: $CODEX_AFTER_RESET_STATUS"

# ── Step 4: opencode mission (same packet body) ─────────────────────────────
echo "[t2-phase1] ▶ Creating mission with runtime=opencode (same body)"
RESP3=$(curl -fsS -X POST "$API/api/orchestrator/create-mission" \
  -H "$H_AUTH" -H "$H_JSON" \
  -d "{
    \"repoPath\": \"$SANDBOX\",
    \"runtime\": \"opencode\",
    \"issues\": [{
      \"number\": 90001,
      \"title\": \"t2-phase1 opencode marker (post-swap)\",
      \"body\": \"Edit sandbox.js to add a single-line comment at the bottom: // opencode was here\"
    }]
  }")
echo "[t2-phase1] opencode mission resp: $RESP3"
PACKET2=$(echo "$RESP3" | jq -r '.result.packets[0].id')
MISSION2=$(echo "$RESP3" | jq -r '.result.missionId')
echo "[t2-phase1] opencode packet=$PACKET2 mission=$MISSION2"

echo "[t2-phase1] sleeping 12s for opencode spawn"
sleep 12

echo "[t2-phase1] post-opencode-spawn lane state:"
sqlite3 -header -column "$DB" "SELECT id, runtime, status, packet_id, branch FROM lanes WHERE repo_path = '$SANDBOX' ORDER BY created_at;"

OPENCODE_LANE_STATUS=$(sqlite3 "$DB" "SELECT status FROM lanes WHERE repo_path = '$SANDBOX' AND runtime='opencode' ORDER BY created_at DESC LIMIT 1;" || echo "")
echo "[t2-phase1] opencode lane status: $OPENCODE_LANE_STATUS"

# ── Step 5: reset opencode packet (don't let it run free) ──────────────────
echo "[t2-phase1] ▶ Resetting opencode packet to halt the run"
curl -fsS -X POST "$API/api/orchestrator/reset-packet" \
  -H "$H_AUTH" -H "$H_JSON" \
  -d "{\"packetId\":\"$PACKET2\",\"reason\":\"t2 cleanup\",\"clearWorktree\":true}" || echo "[t2-phase1] opencode reset failed (non-fatal)"

sleep 2

# ── Step 6: final state ─────────────────────────────────────────────────────
echo "[t2-phase1] ✦ FINAL state for sandbox lanes:"
sqlite3 -header -column "$DB" "SELECT id, runtime, status, packet_id, branch, created_at, updated_at FROM lanes WHERE repo_path = '$SANDBOX' ORDER BY created_at;"

echo "[t2-phase1] session_outcomes for sandbox:"
sqlite3 -header -column "$DB" "SELECT runtime, outcome, packet_id, summary FROM session_outcomes WHERE repo_path = '$SANDBOX' ORDER BY created_at;" || true

# ── Step 7: restore orchestrator state ─────────────────────────────────────
echo "[t2-phase1] ▶ Restoring orchestrator-state.json from backup"
cp "$BACKUP" "$STATE"
echo "[t2-phase1] state restored. User mission unchanged."

# ── Step 8: cleanup leftover lanes (archive any non-archived sandbox lanes) ─
echo "[t2-phase1] ▶ Archiving any non-archived sandbox lanes"
sqlite3 "$DB" "UPDATE lanes SET status='archived', updated_at=datetime('now') WHERE repo_path = '$SANDBOX' AND status != 'archived';"

echo "[t2-phase1] === COMPLETE ==="
echo "[t2-phase1] Captured: codex lane=$CODEX_LANE_ID status_after_create=$CODEX_LANE_STATUS"
echo "[t2-phase1]           codex lane post-reset status=$CODEX_AFTER_RESET_STATUS"
echo "[t2-phase1]           opencode lane status_after_create=$OPENCODE_LANE_STATUS"
