/**
 * #1214 — Recovered packets must not stay bound to dead lanes.
 *
 * Live repro: a Codex worker died (silent_exit_no_work) and its lane was
 * archived WITH the packet binding intact. rerun_with_feedback launched a
 * fresh recovery lane, but skipped the already-terminal original — so the
 * stale archived lane kept lane.packetId. The reconciler then derived packet
 * status 'archived' from it (blocking redispatch), governance reads resolved
 * to the dead lane, and approve_and_merge short-circuited every merge with
 * "Already released (via auto-merge)" although no merge ever landed.
 *
 * Invariants under test:
 *   - the rerun lane sweep clears packetId on TERMINAL (archived/completed)
 *     lanes instead of skipping them, so recovery rebinds cleanly
 *   - isTerminalReleaseLane treats an archived lane as release evidence only
 *     when it actually passed through 'completed' (i.e. a merge landed)
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// The SQLite store resolves its data dir at module load — point it at a temp
// dir BEFORE importing anything that touches the registry. Imports below are
// dynamic for the same reason (static imports would hoist above this line).
process.env.O8_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-lane-rebind-'));

const { createLane, getLane, listLanes, setLaneStatus } = await import('@/lib/lane/registry');
const { archiveLanesForPacket } = await import('@/lib/orchestrator/operator-mission-service/rerun-with-feedback');
const { isTerminalReleaseLane } = await import('@/lib/orchestrator/operator-mission-service/merge');

function laneFixture(packetId: string, branch: string) {
  return createLane({
    repoPath: '/tmp/o8-lane-rebind-repo',
    branch,
    runtime: 'codex',
    packetId,
  });
}

describe('rerun_with_feedback lane sweep (#1214)', () => {
  it('unbinds an already-archived lane so recovery rebinds to the new lane', () => {
    const packetId = 'pkt-1214-dead-worker';
    const dead = laneFixture(packetId, 'inline/dead-worker');
    // Worker died → supervisor archived the lane without clearing packetId.
    setLaneStatus(dead.id, 'archived', 'system');

    archiveLanesForPacket(packetId, 'TEST-1');

    const swept = getLane(dead.id);
    expect(swept?.packetId ?? '').toBe('');
    expect(swept?.status).toBe('archived');

    // Recovery dispatch creates the new lane — it must be the SOLE binding.
    const recovery = laneFixture(packetId, 'inline/dead-worker');
    const bound = listLanes().filter((lane) => lane.packetId === packetId);
    expect(bound.map((lane) => lane.id)).toEqual([recovery.id]);
  });

  it('still archives + unbinds active lanes (pre-#1214 behavior preserved)', () => {
    const packetId = 'pkt-1214-active';
    const active = laneFixture(packetId, 'inline/active');
    setLaneStatus(active.id, 'running', 'system');

    archiveLanesForPacket(packetId, 'TEST-2');

    const swept = getLane(active.id);
    expect(swept?.packetId ?? '').toBe('');
    expect(swept?.status).toBe('archived');
  });
});

describe('isTerminalReleaseLane (#1214)', () => {
  it('does NOT treat a dead archived lane as release evidence', async () => {
    const packetId = 'pkt-1214-not-released';
    const dead = laneFixture(packetId, 'inline/not-released');
    setLaneStatus(dead.id, 'archived', 'system');

    expect(await isTerminalReleaseLane(packetId)).toBe(false);
  });

  it('treats a completed lane as released', async () => {
    const packetId = 'pkt-1214-completed';
    const merged = laneFixture(packetId, 'inline/completed');
    setLaneStatus(merged.id, 'completed', 'system');

    expect(await isTerminalReleaseLane(packetId)).toBe(true);
  });

  it('treats a lane archived AFTER completing (auto-archive of a merged lane) as released', async () => {
    const packetId = 'pkt-1214-merged-then-archived';
    const merged = laneFixture(packetId, 'inline/merged-then-archived');
    setLaneStatus(merged.id, 'completed', 'system');
    setLaneStatus(merged.id, 'archived', 'system');

    expect(await isTerminalReleaseLane(packetId)).toBe(true);
  });
});
