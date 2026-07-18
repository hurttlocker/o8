/**
 * Stop / kill an agent — the symmetric counterpart to dispatch (#1286).
 *
 * `resetPacket` archives the lane + prunes the worktree but does NOT reap the
 * runtime process, so a plain reset can leave an orphaned `codex exec` churning
 * against a pruned worktree (the zombie case the operator hit via Symon). A true
 * stop must INTERRUPT the live session first (kills the process via the runtime
 * adapter), THEN archive — and must NOT relaunch. "Stop" means stop.
 */
import { interruptLaneSessions, killLaneSessionsConfirmed } from '@/lib/lane/reap-sessions';

export interface StopPacketResult {
  ok: boolean;
  packetId: string;
  interruptedSessions: number;
  archivedLanes: number;
  worktreePruned: boolean;
  /** #1471 S1 — false when a worker survived even SIGKILL (lane parked kill_unconfirmed). */
  killConfirmed: boolean;
  /** Set to 'kill_unconfirmed' when the process could not be confirmed dead. */
  blockedReason?: string;
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

  // #1528 — idempotent no-op: nothing bound anywhere means nothing to stop.
  // Stopping an already-gone packet must return success in milliseconds, never
  // fall through to resetPacket's "not found" throw.
  if (lanes.length === 0 && !(await packetKnownToMissionState(packetId))) {
    return {
      ok: true,
      packetId,
      interruptedSessions: 0,
      archivedLanes: 0,
      worktreePruned: false,
      killConfirmed: true,
      note: `Nothing to stop — no live lanes and no mission packet for ${packetId}.`,
    };
  }

  // #1471 S1 — confirmed kill FIRST. Escalate SIGINT→SIGTERM→SIGKILL and verify
  // exit before touching lane state, so we never archive + prune a worktree out
  // from under a worker that is still churning (the zombie the stop verb exists
  // to prevent). If ANY session survived even SIGKILL, park the packet
  // `kill_unconfirmed` and DO NOT archive/prune — telling the truth beats lying.
  const kills = await killLaneSessionsConfirmed(lanes);
  const reaped = kills.filter((kill) => kill.confirmed || kill.alreadyDead).length;
  const survivors = kills.filter((kill) => !kill.confirmed && !kill.alreadyDead);

  if (survivors.length > 0) {
    await markPacketKillUnconfirmed(packetId, survivors.map((survivor) => ({
      laneId: survivor.laneId,
      sessionKey: survivor.sessionKey,
      pid: survivor.pid,
    })));
    return {
      ok: false,
      packetId,
      interruptedSessions: reaped,
      archivedLanes: 0,
      worktreePruned: false,
      killConfirmed: false,
      blockedReason: 'kill_unconfirmed',
      note: `Stop could not confirm ${survivors.length} live worker${survivors.length === 1 ? '' : 's'} exited after SIGKILL. Packet parked kill_unconfirmed; worktree left intact. Reset again or kill the pid manually.`,
    };
  }

  // #1528 — stop's contract is answered at kill-confirm. Hold the packet under
  // the lock NOW (cheap, blocks every relaunch path), then background the
  // archive + worktree prune: rm -rf of a node_modules-cloned worktree runs for
  // minutes and used to hold this response open until undici's client timeout
  // fired and the CLI misreported connection_refused while the server listened.
  await markPacketStoppedHeld(packetId);
  void resetPacket({
    packetId,
    clearWorktree: true,
    reason: 'stopped by operator (#1286)',
  }).then((reset) => {
    const pruned = (reset as { worktreePruned?: boolean }).worktreePruned === true;
    console.log(`[stop-packet] background cleanup finished for ${packetId}${pruned ? ' (worktree pruned)' : ''}`);
  }).catch((error) => {
    console.warn(`[stop-packet] background cleanup failed for ${packetId} — packet stays held:`, error);
  });

  return {
    ok: true,
    packetId,
    interruptedSessions: reaped,
    archivedLanes: lanes.length,
    worktreePruned: false,
    killConfirmed: true,
    note: `Stopped packet ${packetId}: confirmed-killed ${reaped} live session${reaped === 1 ? '' : 's'}; held against relaunch. Archiving ${lanes.length} lane${lanes.length === 1 ? '' : 's'} + pruning the worktree in the background (audit via lane events). Not relaunched.`,
  };
}

/** #1528 — cheap existence probe so stop can no-op honestly. */
async function packetKnownToMissionState(packetId: string): Promise<boolean> {
  try {
    const { readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
    if (readOrchestratorControlPlaneState().packets.some((packet) => packet.id === packetId)) return true;
  } catch { /* fall through to registry probe */ }
  try {
    const { findMissionRegistryEntryByPacketId } = await import('@/lib/orchestrator/mission-registry');
    return Boolean(findMissionRegistryEntryByPacketId(packetId, { includeArchived: false }));
  } catch {
    return false;
  }
}

/**
 * #1528 — the anti-relaunch guard that must be DURABLE before the response
 * returns: operatorStopped + held under the control-plane lock, so the
 * backgrounded cleanup can take minutes without a dispatch tick relaunching
 * the packet in the window. Best-effort — a failed write is logged, and the
 * backgrounded resetPacket applies the same hold again when it lands.
 */
async function markPacketStoppedHeld(packetId: string): Promise<void> {
  try {
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      if (!packet) return;
      packet.operatorStopped = true;
      packet.queueState = 'held';
      packet.status = 'blocked';
      packet.blockedReason = 'operator_stopped';
      packet.lastEventAt = new Date().toISOString();
      packet.lastEventLabel = 'operator_stopped';
    });
  } catch (error) {
    console.warn(`[stop-packet] failed to mark packet ${packetId} operator-stopped before background cleanup:`, error);
  }
}

/**
 * #1471 S1 — park a packet `kill_unconfirmed` when its worker survived SIGKILL.
 * Held under the control-plane lock so a concurrent dispatch tick can't relaunch
 * it. Best-effort — a failed write is logged, never thrown.
 */
async function markPacketKillUnconfirmed(
  packetId: string,
  survivors: Array<{ laneId: string; sessionKey: string; pid?: number }>,
): Promise<void> {
  try {
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      if (!packet) return;
      packet.operatorStopped = true;
      packet.queueState = 'held';
      packet.status = 'blocked';
      packet.blockedReason = 'kill_unconfirmed';
      packet.lastEventAt = new Date().toISOString();
      packet.lastEventLabel = 'kill_unconfirmed';
    });
  } catch (error) {
    console.warn(`[kill] failed to mark packet ${packetId} kill_unconfirmed:`, error);
  }
  console.warn(
    `[kill] packet ${packetId}: ${survivors.length} worker(s) unconfirmed after SIGKILL — ${survivors
      .map((survivor) => `${survivor.sessionKey}${survivor.pid ? ` pid ${survivor.pid}` : ''}`)
      .join(', ')}`,
  );
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
