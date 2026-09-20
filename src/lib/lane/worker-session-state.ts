import { getLaneEvents } from '@/lib/lane/registry';
import type { Lane, LaneEvent } from '@/lib/lane/types';
import { lookupOwnedActiveRunFresh, ownedRoots } from '@/lib/runtimes/shared/owned-session-index';

function eventMatchesWorkerSession(event: LaneEvent, lane: Lane): boolean {
  if (event.verb !== 'runtime_process_exit') return false;
  const surfaceId = typeof event.payload.surfaceId === 'string'
    ? event.payload.surfaceId.trim()
    : '';
  const sessionKey = lane.sessionKey?.trim() ?? '';
  if (surfaceId && sessionKey) return surfaceId === sessionKey;
  return !surfaceId || !sessionKey;
}

/** The newest durable process-exit receipt for this lane's worker session. */
export function newestWorkerProcessExit(lane: Lane): LaneEvent | null {
  return getLaneEvents(lane.id, 200)
    .findLast((event) => eventMatchesWorkerSession(event, lane)) ?? null;
}

/** Immutable attempt identity for an owned worker completion. */
export function workerExitAttemptId(event: LaneEvent): string {
  const runId = typeof event.payload.runId === 'string' ? event.payload.runId.trim() : '';
  return runId ? `run:${runId}` : `exit:${event.id}`;
}

export function hasRecordedWorkerExit(lane: Lane): boolean {
  return newestWorkerProcessExit(lane) !== null;
}

export function hasRecordedCleanWorkerExit(lane: Lane): boolean {
  const event = newestWorkerProcessExit(lane);
  if (!event) return false;
  const { classification, exitCode, runtimeOutcome, signal } = event.payload;
  if (runtimeOutcome === 'failed') return false;
  return classification === 'clean-exit'
    || (exitCode === 0 && (signal === null || signal === undefined));
}

/**
 * A worker can close between runtime launch and lane-session attachment. The
 * exit receipt is durable, but only reconcile it after confirming this exact
 * owned session has no newer active run. That prevents an earlier run from
 * completing a resumed worker that reuses its surface id.
 */
export async function hasCurrentCleanWorkerExit(lane: Lane): Promise<boolean> {
  const sessionKey = lane.sessionKey?.trim();
  if (!sessionKey || !hasRecordedCleanWorkerExit(lane)) return false;
  const activeRun = await lookupOwnedActiveRunFresh(sessionKey);
  return activeRun !== null && Object.keys(activeRun).length === 0;
}

/**
 * Return one target per worker session that still needs death confirmation.
 * Owned sessions can resume after a recorded exit. Always send them through
 * the fresh saved-run lookup and identity-checked kill path, including settled
 * sessions (already dead) and prepared runs (not yet safe to declare dead).
 * Review turns are tracked separately and never enter this worker kill set.
 */
export function liveWorkerSessionLanes(lanes: Lane[]): Lane[] {
  const seen = new Set<string>();
  const live: Lane[] = [];
  const roots = ownedRoots();
  for (const lane of lanes) {
    const sessionKey = lane.sessionKey?.trim();
    if (!sessionKey) continue;
    const owned = roots.some(({ marker }) => sessionKey.startsWith(marker));
    if (!owned && hasRecordedWorkerExit(lane)) continue;
    const key = `${lane.runtime}\0${sessionKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    live.push(lane);
  }
  return live;
}
