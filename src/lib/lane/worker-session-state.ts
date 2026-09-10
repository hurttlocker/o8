import { getLaneEvents } from '@/lib/lane/registry';
import type { Lane, LaneEvent } from '@/lib/lane/types';
import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';

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
