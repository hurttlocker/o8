import type { Lane } from '@/lib/lane/types';
import type { RuntimeId } from '@/lib/runtimes/types';

/**
 * Reap live runtime processes for a set of lanes — shared by `stop-packet`
 * (#1286) and `reset_packet` (#1292) so BOTH hard-cancel the underlying process
 * before the lane's sessionKey is nulled. Without this, reset archived the lane
 * but left the `codex exec` churning, and when that orphan exited/failed the
 * agent-supervisor relaunched it into a sibling lane (the zombie-multiply bug).
 *
 * Interrupt (SIGINT via the runtime adapter) is a CLEAN stop, not a `failed`
 * status, so the supervisor does not auto-retry it — confirmed by stop-packet's
 * proven "not relaunched" behavior.
 */

export interface InterruptTarget {
  laneId: string;
  runtime: RuntimeId;
  sessionKey: string;
}

/**
 * Pure: the lanes that have a live session to interrupt, as (laneId, runtime,
 * sessionKey) triples. Lanes with no/blank sessionKey are skipped (nothing to
 * reap). Captured from the lane list BEFORE any mutation nulls sessionKey.
 */
export function interruptableSessions(lanes: Lane[]): InterruptTarget[] {
  const out: InterruptTarget[] = [];
  for (const lane of lanes) {
    const sessionKey = lane.sessionKey?.trim();
    if (!sessionKey) continue;
    out.push({ laneId: lane.id, runtime: lane.runtime as RuntimeId, sessionKey });
  }
  return out;
}

/**
 * Interrupt each lane's live session through the universal runtime router
 * (reaps the process per-runtime). Best-effort: a failed kill is logged, not
 * thrown — the caller's archive still proceeds. Returns the number reaped.
 */
export async function interruptLaneSessions(lanes: Lane[]): Promise<number> {
  const targets = interruptableSessions(lanes);
  if (targets.length === 0) return 0;
  const { routeAction } = await import('@/lib/runtimes/registry');
  let interrupted = 0;
  for (const target of targets) {
    try {
      await routeAction(target.runtime, 'interrupt', target.sessionKey);
      interrupted += 1;
    } catch (error) {
      console.warn(`[reap-sessions] interrupt failed for lane ${target.laneId} (${target.runtime}):`, error);
    }
  }
  return interrupted;
}
