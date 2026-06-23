/**
 * Stop / kill an agent — the symmetric counterpart to dispatch (#1286).
 *
 * `resetPacket` archives the lane + prunes the worktree but does NOT reap the
 * runtime process, so a plain reset can leave an orphaned `codex exec` churning
 * against a pruned worktree (the zombie case the operator hit via Symon). A true
 * stop must INTERRUPT the live session first (kills the process via the runtime
 * adapter), THEN archive — and must NOT relaunch. "Stop" means stop.
 */
import type { Lane } from '@/lib/lane/types';
import type { RuntimeId } from '@/lib/runtimes/types';

export interface StopPacketResult {
  ok: boolean;
  packetId: string;
  interruptedSessions: number;
  archivedLanes: number;
  worktreePruned: boolean;
  note: string;
}

export interface StopAllResult {
  ok: boolean;
  stoppedPackets: number;
  interruptedSessions: number;
  archivedLanes: number;
  note: string;
}

/**
 * Stop a single packet: kill its live runtime process(es), archive its lane(s),
 * prune the worktree — no relaunch. The interrupt MUST run before resetPacket
 * nulls sessionKey, or the runtime process is orphaned (#1286).
 */
export async function stopPacket(packetId: string): Promise<StopPacketResult> {
  const { listLanes } = await import('@/lib/lane/registry');
  const { resetPacket } = await import('@/lib/orchestrator/operator-mission-service');

  const lanes = listLanes().filter((lane) => lane.packetId === packetId);
  const interrupted = await interruptLaneSessions(lanes);

  const reset = await resetPacket({
    packetId,
    clearWorktree: true,
    reason: 'stopped by operator (#1286)',
  });
  const worktreePruned = (reset as { worktreePruned?: boolean }).worktreePruned === true;

  return {
    ok: true,
    packetId,
    interruptedSessions: interrupted,
    archivedLanes: lanes.length,
    worktreePruned,
    note: `Stopped packet ${packetId}: reaped ${interrupted} live session${interrupted === 1 ? '' : 's'}, archived ${lanes.length} lane${lanes.length === 1 ? '' : 's'}${worktreePruned ? ', pruned worktree' : ''}. Not relaunched.`,
  };
}

/**
 * Clean slate: stop every active lane in scope — kill live processes, archive
 * lanes (including orphans with no packetId), prune worktrees. No relaunch.
 */
export async function stopAllLanes(opts: { repoPath?: string } = {}): Promise<StopAllResult> {
  const { listActiveLanes, archiveLane } = await import('@/lib/lane/registry');

  const active = listActiveLanes().filter(
    (lane) => !opts.repoPath || lane.repoPath === opts.repoPath,
  );
  const packetIds = new Set<string>();
  for (const lane of active) {
    if (lane.packetId) packetIds.add(lane.packetId);
  }

  let interrupted = 0;
  let archived = 0;

  // Packets with bound lanes go through the full stop (interrupt + archive + prune).
  for (const packetId of packetIds) {
    try {
      const result = await stopPacket(packetId);
      interrupted += result.interruptedSessions;
      archived += result.archivedLanes;
    } catch (error) {
      console.warn(`[stop-packet] stopAll: failed to stop packet ${packetId}:`, error);
    }
  }

  // Orphan lanes (no packetId — e.g. zombie remnants) get interrupted + archived directly.
  const orphans = active.filter((lane) => !lane.packetId);
  interrupted += await interruptLaneSessions(orphans);
  for (const lane of orphans) {
    try {
      archiveLane(lane.id, 'user');
      archived += 1;
    } catch (error) {
      console.warn(`[stop-packet] stopAll: failed to archive orphan lane ${lane.id}:`, error);
    }
  }

  return {
    ok: true,
    stoppedPackets: packetIds.size,
    interruptedSessions: interrupted,
    archivedLanes: archived,
    note: `Stopped everything${opts.repoPath ? ' in this repo' : ''}: reaped ${interrupted} live session${interrupted === 1 ? '' : 's'}, archived ${archived} lane${archived === 1 ? '' : 's'} across ${packetIds.size} packet${packetIds.size === 1 ? '' : 's'}. Nothing relaunched.`,
  };
}

/** Interrupt each lane's live session through the universal runtime router
 *  (reaps the process per-runtime). Best-effort: a failed kill is logged, not
 *  thrown — the archive still proceeds. Returns the number actually reaped. */
async function interruptLaneSessions(lanes: Lane[]): Promise<number> {
  const { routeAction } = await import('@/lib/runtimes/registry');
  let interrupted = 0;
  for (const lane of lanes) {
    const sessionKey = lane.sessionKey?.trim();
    if (!sessionKey) continue;
    try {
      await routeAction(lane.runtime as RuntimeId, 'interrupt', sessionKey);
      interrupted += 1;
    } catch (error) {
      console.warn(`[stop-packet] interrupt failed for lane ${lane.id} (${lane.runtime}):`, error);
    }
  }
  return interrupted;
}
