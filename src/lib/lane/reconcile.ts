import { existsSync } from 'node:fs';

import { createApproval } from '@/lib/approvals/store';
import { listLanes, setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneRuntime, LaneStatus } from '@/lib/lane/types';
import { getRuntime } from '@/lib/runtimes';

function isStuckLane(lane: Lane) {
  return lane.status === 'running' || lane.status === 'launching';
}

async function discoverSessionKeysByRuntime(lanes: Lane[]) {
  const runtimeIds = [...new Set(lanes.map((lane) => lane.runtime))];
  const discoveredSessionsByRuntime = new Map<LaneRuntime, Set<string> | null>();

  await Promise.all(runtimeIds.map(async (runtimeId) => {
    const runtime = getRuntime(runtimeId);
    if (!runtime) {
      console.warn(`[reconcile] Runtime ${runtimeId} is not registered; skipping lane checks for that runtime`);
      discoveredSessionsByRuntime.set(runtimeId, null);
      return;
    }

    try {
      const sessions = await runtime.discoverSessions();
      discoveredSessionsByRuntime.set(
        runtimeId,
        new Set(sessions.map((session) => session.sessionKey)),
      );
    } catch (error) {
      console.warn(
        `[reconcile] Failed to discover ${runtimeId} sessions during startup reconciliation: ${error instanceof Error ? error.message : String(error)}`,
      );
      discoveredSessionsByRuntime.set(runtimeId, null);
    }
  }));

  return discoveredSessionsByRuntime;
}

function createSessionLostApproval(lane: Lane) {
  const label = lane.label || lane.branch;
  return createApproval({
    source: 'runtime',
    runtime: lane.runtime,
    agent: label,
    sessionKey: lane.sessionKey || `lane:${lane.id}`,
    title: 'Agent session lost',
    description: `The agent session for lane "${label}" was lost during app restart. Resume the task or archive the lane.`,
    summary: `Lane "${label}" needs a resume after app restart`,
    risk: 'medium',
    metadata: {
      Lane: lane.id,
      Branch: lane.branch,
      Runtime: lane.runtime,
      ...(lane.packetId ? { Packet: lane.packetId } : {}),
    },
    continuation: {
      kind: 'lane',
      laneId: lane.id,
      verb: 'resume',
    },
  });
}

// #534 follow-up — orchestrator often bash-merges (git merge + git push) and
// cleans up its worktree without invoking the lane `merge` verb. The git
// state is correct but the lane SQLite record stays stuck in 'reviewing'
// forever because setLaneStatus never fired. Solution: detect lanes whose
// worktree path no longer exists on disk and auto-transition them to
// 'completed'. Model-agnostic — works whether the agent used the merge verb,
// raw bash, or any other path. Synchronous so it can run inside hot request
// handlers without a round-trip to the event loop for each stat call.
const RECONCILABLE_WORKTREE_STATUSES: ReadonlySet<LaneStatus> = new Set<LaneStatus>([
  'reviewing',
  'merging',
  'awaiting_input',
]);

export function reconcileOrphanedWorktrees(): number {
  const candidates = listLanes().filter(
    (lane) =>
      RECONCILABLE_WORKTREE_STATUSES.has(lane.status)
      && typeof lane.worktreePath === 'string'
      && lane.worktreePath.length > 0
      && !existsSync(lane.worktreePath),
  );
  if (candidates.length === 0) return 0;

  let reconciled = 0;
  for (const lane of candidates) {
    const updated = setLaneStatus(lane.id, 'completed', 'system', 'worktree_missing_reconciled');
    if (updated) {
      reconciled += 1;
      console.log(
        `[reconcile] Lane ${lane.id} (${lane.label || lane.branch}) worktree ${lane.worktreePath} is gone — transitioned ${lane.status} → completed`,
      );
    }
  }
  return reconciled;
}

export async function reconcileStuckLanes(): Promise<void> {
  const candidateLanes = listLanes().filter(isStuckLane);
  let recoveredCount = 0;

  if (candidateLanes.length === 0) {
    console.log('[reconcile] Checked 0 lanes, recovered 0 stuck lanes');
    return;
  }

  const discoveredSessionsByRuntime = await discoverSessionKeysByRuntime(candidateLanes);

  for (const lane of candidateLanes) {
    const liveSessionKeys = discoveredSessionsByRuntime.get(lane.runtime);
    if (liveSessionKeys === undefined || liveSessionKeys === null) {
      continue;
    }

    if (lane.sessionKey && liveSessionKeys.has(lane.sessionKey)) {
      continue;
    }

    try {
      const updatedLane = setLaneStatus(lane.id, 'paused', 'system', 'session_lost');
      if (!updatedLane) {
        console.warn(`[reconcile] Lane ${lane.id} disappeared before it could be paused`);
        continue;
      }

      createSessionLostApproval(lane);
      recoveredCount += 1;
    } catch (error) {
      console.warn(
        `[reconcile] Failed to recover lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  console.log(`[reconcile] Checked ${candidateLanes.length} lanes, recovered ${recoveredCount} stuck lanes`);
}
