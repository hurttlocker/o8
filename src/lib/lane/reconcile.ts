import { createApproval } from '@/lib/approvals/store';
import { listLanes, setLaneStatus } from '@/lib/lane/registry';
import type { Lane, LaneRuntime } from '@/lib/lane/types';
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
