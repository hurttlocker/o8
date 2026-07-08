import { eq } from 'drizzle-orm';

import { getDb, lanes } from '@/lib/db';
import { isBridgeSessionAlive } from '@/lib/runtime/pty-bridge';
import { getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import { findLiveCodexProcessByCwd } from '@/lib/runtimes/shared/codex-process-cwd';
import { lookupOwnedActiveRun } from '@/lib/runtimes/shared/owned-session-index';
import type { Lane } from './types';
import {
  appendEvent,
  archiveLane,
  getLane,
  getLaneEvents,
  listActiveLanes,
  updateLane,
} from './registry';
import { preserveLaneWorktreeHead, type LaneWorktreePreservation } from './worktree-preservation';
import { enforceWedgeTimeouts } from './wedge-timeouts';

export const LANE_ZOMBIE_REAPER_INTERVAL_MS = 5 * 60_000;
export const LANE_HEARTBEAT_STALE_MS = 90_000;


let zombieReaperTimer: ReturnType<typeof setInterval> | null = null;
let zombieReaperInFlight = false;

export interface LaneOwnerProbe {
  alive: boolean | undefined;
  source: string;
  pid?: number;
  sessionName?: string;
  note?: string;
}

export interface ZombieLaneCandidate {
  lane: Lane;
  staleMs: number;
  lastHeartbeatAt: number | null;
  probe: LaneOwnerProbe;
  reason: 'missing_heartbeat' | 'stale_heartbeat' | 'stale_merging';
}

function getLaneDb() {
  const db = getDb();
  if (!db) {
    throw new Error('[lane-reaper] SQLite database is unavailable');
  }
  return db;
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLivePidSessionKey(sessionKey: string): number | null {
  const match = sessionKey.match(/^(?:codex-live:|claude-code:live-)(\d+)$/);
  if (!match?.[1]) return null;
  const pid = Number(match[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

async function probeCodexWorktreeContinuity(
  sessionKey: string,
  lane: Lane,
): Promise<LaneOwnerProbe | null> {
  if (!sessionKey.startsWith('codex-owned:')) return null;
  const match = await findLiveCodexProcessByCwd(lane.worktreePath);
  if (!match) return null;
  return {
    alive: true,
    source: 'codex-process-cwd',
    pid: match.pid,
    note: 'live codex process cwd matches lane worktree',
  };
}

async function probeOwnedSession(
  sessionKey: string,
  lane: Lane,
): Promise<LaneOwnerProbe> {
  // Shared, TTL-memoized owned-session index (perf 2026-07-03) — one readdir
  // per root per tick, shared with the silent-exit detector, instead of a
  // per-lane scan. Semantics unchanged: null=gone, {}=cleared.
  const run = await lookupOwnedActiveRun(sessionKey);
  if (!run) {
    return (await probeCodexWorktreeContinuity(sessionKey, lane))
      ?? { alive: false, source: 'owned-session-registry', note: 'owned session metadata not found' };
  }
  if (run.tmuxSession === undefined && run.pid === undefined) {
    return (await probeCodexWorktreeContinuity(sessionKey, lane))
      ?? { alive: false, source: 'owned-session-registry', note: 'owned session activeRun cleared' };
  }
  if (run.tmuxSession) {
    const alive = await isBridgeSessionAlive(run.tmuxSession);
    if (!alive) {
      const continuity = await probeCodexWorktreeContinuity(sessionKey, lane);
      if (continuity) return continuity;
    }
    return {
      alive,
      source: 'owned-session-registry',
      sessionName: run.tmuxSession,
      pid: run.pid,
    };
  }
  const pidAlive = isPidAlive(run.pid);
  if (!pidAlive) {
    const continuity = await probeCodexWorktreeContinuity(sessionKey, lane);
    if (continuity) return continuity;
  }
  return {
    alive: pidAlive,
    source: 'owned-session-registry',
    pid: run.pid,
  };
}

async function findOwnerPidViaWorktreeManager(lane: Lane): Promise<number | null | undefined> {
  if (!lane.worktreePath) return undefined;
  try {
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const manager = new WorktreeManager(lane.repoPath);
    const maybeFindOwnerPid = (manager as unknown as {
      findOwnerPid?: (worktreePath: string) => Promise<number | null> | number | null;
    }).findOwnerPid;
    if (!maybeFindOwnerPid) return undefined;
    const pid = await maybeFindOwnerPid.call(manager, lane.worktreePath);
    return typeof pid === 'number' && Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return undefined;
  }
}

async function probeClaudeCodeCwd(lane: Lane): Promise<LaneOwnerProbe> {
  try {
    const { findLiveClaudeProcesses } = await import('@/lib/runtimes/claude-code');
    const processes = await findLiveClaudeProcesses();
    const targetCwds = [lane.worktreePath, lane.repoPath]
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value));
    if (targetCwds.length === 0) {
      return { alive: undefined, source: 'claude-process-cwd', note: 'no cwd to compare' };
    }
    const match = processes.find((proc) => proc.cwd && targetCwds.includes(proc.cwd));
    return {
      alive: Boolean(match),
      source: 'claude-process-cwd',
      pid: match?.pid,
    };
  } catch (error) {
    return {
      alive: undefined,
      source: 'claude-process-cwd',
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeLaneOwner(lane: Lane): Promise<LaneOwnerProbe> {
  const ownerPid = await findOwnerPidViaWorktreeManager(lane);
  if (ownerPid !== undefined) {
    return {
      alive: ownerPid === null ? false : isPidAlive(ownerPid),
      source: 'worktreeManager.findOwnerPid',
      pid: ownerPid ?? undefined,
    };
  }

  const sessionKey = lane.sessionKey?.trim();
  if (!sessionKey) {
    return { alive: false, source: 'lane-session', note: 'running lane has no session key' };
  }

  const livePid = parseLivePidSessionKey(sessionKey);
  if (livePid) {
    return { alive: isPidAlive(livePid), source: 'session-key-pid', pid: livePid };
  }

  if (sessionKey.startsWith('codex-owned:')) {
    return probeOwnedSession(sessionKey, lane);
  }
  if (sessionKey.startsWith('claude-code-owned:')) {
    return probeOwnedSession(sessionKey, lane);
  }
  if (sessionKey.startsWith('gemini-owned:')) {
    return probeOwnedSession(sessionKey, lane);
  }
  if (sessionKey.startsWith('opencode-owned:')) {
    return probeOwnedSession(sessionKey, lane);
  }

  const terminalSession = getRuntimeTerminalSession(sessionKey);
  if (terminalSession?.sessionName) {
    return {
      alive: await isBridgeSessionAlive(terminalSession.sessionName),
      source: 'terminal-session-registry',
      sessionName: terminalSession.sessionName,
    };
  }

  if (lane.runtime === 'claude-code') {
    return probeClaudeCodeCwd(lane);
  }

  return { alive: undefined, source: 'process-registry', note: 'no owner pid mapping found' };
}

function heartbeatStaleMs(lane: Lane, now: number): number {
  if (typeof lane.lastHeartbeatAt === 'number' && Number.isFinite(lane.lastHeartbeatAt)) {
    return now - lane.lastHeartbeatAt;
  }
  const updatedAtMs = Date.parse(lane.updatedAt);
  return Number.isFinite(updatedAtMs) ? now - updatedAtMs : Number.POSITIVE_INFINITY;
}

function actorStatusTransitionGraceMs(lane: Lane, now: number): number | null {
  const events = getLaneEvents(lane.id, 80);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.verb !== 'status_change') continue;
    if (event.actor !== 'orchestrator' && event.actor !== 'user') continue;
    const eventMs = Date.parse(event.timestamp);
    if (!Number.isFinite(eventMs)) continue;
    const ageMs = now - eventMs;
    return ageMs >= 0 ? ageMs : 0;
  }
  return null;
}

export function recordLaneHeartbeat(laneId: string, heartbeatAt: number = Date.now()): Lane | null {
  const lane = getLane(laneId);
  if (!lane) return null;

  getLaneDb()
    .update(lanes)
    .set({ lastHeartbeatAt: heartbeatAt })
    .where(eq(lanes.id, laneId))
    .run();

  return getLane(laneId);
}

export async function listZombieLaneCandidates(now: number = Date.now()): Promise<ZombieLaneCandidate[]> {
  const candidates: ZombieLaneCandidate[] = [];
  const runningLanes = listActiveLanes().filter((lane) => lane.status === 'running');

  for (const lane of runningLanes) {
    const staleMs = heartbeatStaleMs(lane, now);
    if (staleMs <= LANE_HEARTBEAT_STALE_MS) continue;
    const actorGraceMs = actorStatusTransitionGraceMs(lane, now);
    if (actorGraceMs !== null && actorGraceMs <= LANE_HEARTBEAT_STALE_MS) continue;

    const probe = await probeLaneOwner(lane);
    if (probe.alive !== false) continue;

    candidates.push({
      lane,
      staleMs,
      lastHeartbeatAt: lane.lastHeartbeatAt,
      probe,
      reason: lane.lastHeartbeatAt === null ? 'missing_heartbeat' : 'stale_heartbeat',
    });
  }

  // Lanes stuck in `merging`: the merge runs inside the Next server process
  // and doesn't heartbeat, so a hard process death mid-merge leaves the lane
  // in `merging` forever — invisible to both this reaper (running-only) and
  // the silent-exit detector. Real merges, including time queued behind the
  // per-repo merge lock, finish in minutes; long silence means the owning
  // process died.
  const MERGING_STALE_MS = 30 * 60 * 1000;
  const mergingLanes = listActiveLanes().filter((lane) => lane.status === 'merging');
  for (const lane of mergingLanes) {
    const lastTouch = lane.lastEventAt ? Date.parse(lane.lastEventAt) : Number.NaN;
    const staleMs = Number.isFinite(lastTouch) ? now - lastTouch : Number.MAX_SAFE_INTEGER;
    if (staleMs <= MERGING_STALE_MS) continue;
    candidates.push({
      lane,
      staleMs,
      lastHeartbeatAt: lane.lastHeartbeatAt,
      probe: { alive: false, source: 'merging-stale', note: 'merge owner process presumed dead (no lane events for 30m+)' },
      reason: 'stale_merging',
    });
  }

  return candidates;
}

export async function reapZombieLane(
  candidate: ZombieLaneCandidate,
  options: { source: 'sidecar' | 'manual'; force?: boolean },
): Promise<Lane | null> {
  const before = getLane(candidate.lane.id);
  if (!before || (before.status !== 'running' && before.status !== 'merging')) return before;
  let preservedWork: LaneWorktreePreservation | null = null;

  if (before.status === 'running' && before.worktreePath) {
    try {
      preservedWork = await preserveLaneWorktreeHead(before);
    } catch (error) {
      console.warn('[lane-reaper] worktree preservation failed before zombie reap:', error);
    }
  }

  const payload = {
    source: options.source,
    force: options.force === true,
    staleMs: candidate.staleMs,
    lastHeartbeatAt: candidate.lastHeartbeatAt,
    previousSessionKey: before.sessionKey,
    processProbe: candidate.probe,
    recommendedAction: before.packetId ? 'retry_packet' : 'inspect_lane',
    preservedBranch: preservedWork?.preserved ? preservedWork.branchName : undefined,
    preservedHead: preservedWork?.preserved ? preservedWork.headSha : undefined,
  };

  // Salvage path (#1282 Failure B): a `running` lane whose owner died may have
  // left COMPLETE, correct edits sitting uncommitted in its worktree — the
  // pre-review auto-commit never ran because the session never reported done.
  // Dumping that straight to `recovering` reads as a failure and the work is
  // invisible. Commit it and route to `reviewing` so the operator sees it.
  // Gate STRICTLY to `running`: a `merging` lane is mid-write, and committing
  // its tree can corrupt the in-flight merge.
  if (before.status === 'running' && before.worktreePath) {
    try {
      const { autoCommitCompletionWorktree, hasReviewableCompletionDiff } =
        await import('@/lib/supervisor/completion-verification');
      const baseRef = before.baseBranch?.trim() || 'main';
      const autoCommitted = preservedWork?.autoCommitted ?? await autoCommitCompletionWorktree(before.worktreePath, before.label);
      const reviewable =
        autoCommitted || (await hasReviewableCompletionDiff(before.worktreePath, baseRef));
      if (reviewable) {
        appendEvent(before.id, 'zombie_reap', 'system', { ...payload, salvaged: true, autoCommitted });
        return updateLane(
          before.id,
          {
            status: 'reviewing',
            sessionKey: null,
            lastEventAt: new Date().toISOString(),
            lastEventLabel: 'zombie_reap_salvaged',
          },
          'system',
        );
      }
    } catch (error) {
      console.warn('[lane-reaper] salvage attempt failed; falling through to recovering:', error);
    }
  }

  appendEvent(before.id, 'zombie_reap', 'system', payload);
  const updated = updateLane(
    before.id,
    {
      status: 'recovering',
      sessionKey: null,
      lastEventAt: new Date().toISOString(),
      lastEventLabel: 'zombie_reap',
    },
    'system',
  );

  if (before.packetId) {
    try {
      const { enqueueSupervisorInboxItem } = await import('@/lib/supervisor/heal-bot');
      enqueueSupervisorInboxItem({
        repoPath: before.repoPath,
        packetId: before.packetId,
        kind: 'session_lost',
        status: 'human_required',
        payload: {
          laneId: before.id,
          worktreePath: before.worktreePath,
          sessionKey: before.sessionKey,
          baseBranch: before.baseBranch,
          note: 'Zombie reaper moved this stale running lane to recovering. Run retry_packet to resume the existing worktree.',
        },
      });
    } catch (error) {
      console.warn('[lane-reaper] Failed to enqueue session_lost inbox item:', error);
    }
  }

  return updated;
}

export async function reapZombieLanes(options: {
  source: 'sidecar' | 'manual';
  force?: boolean;
  now?: number;
}): Promise<Array<{ candidate: ZombieLaneCandidate; lane: Lane | null }>> {
  const candidates = await listZombieLaneCandidates(options.now ?? Date.now());
  const reaped: Array<{ candidate: ZombieLaneCandidate; lane: Lane | null }> = [];
  for (const candidate of candidates) {
    const lane = await reapZombieLane(candidate, options);
    reaped.push({ candidate, lane });
  }
  return reaped;
}

// A lane that lost its session and is NOT actively recovering (no auto-escalate
// re-attempt) gets stuck in `paused`/`recovering` with an empty session_key
// forever — it renders as a phantom "Recovering" agent and never terminalizes.
// Archive any that have been dead this long so they stop showing and don't
// accumulate. Generous threshold so a brief legitimate pause/recovery is safe. (#1282)
export const STALE_DEAD_LANE_MS = 15 * 60_000;

export function archiveStaleDeadLanes(now: number = Date.now()): number {
  let archived = 0;
  for (const lane of listActiveLanes()) {
    if (lane.status !== 'paused' && lane.status !== 'recovering') continue;
    if (lane.sessionKey) continue; // still owns a session — leave it alone
    const lastTouch = lane.lastEventAt ? Date.parse(lane.lastEventAt) : Number.NaN;
    const staleMs = Number.isFinite(lastTouch) ? now - lastTouch : Number.MAX_SAFE_INTEGER;
    if (staleMs <= STALE_DEAD_LANE_MS) continue;
    if (archiveLane(lane.id, 'system')) archived += 1;
  }
  return archived;
}

export async function runLaneZombieReaperTick(): Promise<void> {
  if (zombieReaperInFlight) return;
  zombieReaperInFlight = true;
  try {
    const reaped = await reapZombieLanes({ source: 'sidecar' });
    for (const item of reaped) {
      console.log(
        `[lane-reaper] ${item.candidate.lane.id} stale ${Math.round(item.candidate.staleMs / 1000)}s; owner dead via ${item.candidate.probe.source} — recovering`,
      );
    }
    // Wedge-timeout enforcement runs BEFORE archiveStaleDeadLanes so a
    // packet-bound `recovering` lane escalates to the orchestrator instead of
    // being silently archived out from under its packet.
    try {
      enforceWedgeTimeouts();
    } catch (error) {
      console.error('[lane-lifecycle] wedge-timeout enforcement failed:', error);
    }
    const archivedDead = archiveStaleDeadLanes();
    if (archivedDead > 0) {
      console.log(`[lane-reaper] archived ${archivedDead} stale dead lane(s) (paused/recovering, no session)`);
    }
  } finally {
    zombieReaperInFlight = false;
  }
}

export function startLaneZombieReaper(): void {
  if (zombieReaperTimer) return;

  setTimeout(() => {
    void runLaneZombieReaperTick().catch((error) => {
      console.error('[lane-reaper] initial tick failed:', error);
    });
  }, 60_000);

  zombieReaperTimer = setInterval(() => {
    void runLaneZombieReaperTick().catch((error) => {
      console.error('[lane-reaper] tick failed:', error);
    });
  }, LANE_ZOMBIE_REAPER_INTERVAL_MS);

  if (typeof zombieReaperTimer.unref === 'function') zombieReaperTimer.unref();
  console.log(`[lane-reaper] started (interval ${LANE_ZOMBIE_REAPER_INTERVAL_MS}ms, stale heartbeat ${LANE_HEARTBEAT_STALE_MS}ms)`);
}

export function stopLaneZombieReaper(): void {
  if (!zombieReaperTimer) return;
  clearInterval(zombieReaperTimer);
  zombieReaperTimer = null;
  console.log('[lane-reaper] stopped');
}
