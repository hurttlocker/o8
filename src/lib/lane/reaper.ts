import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';

import { getDb, lanes } from '@/lib/db';
import { isBridgeSessionAlive } from '@/lib/runtime/pty-bridge';
import { getRuntimeTerminalSession } from '@/lib/runtime/terminal-session-registry';
import type { Lane } from './types';
import {
  appendEvent,
  getLane,
  listActiveLanes,
  updateLane,
} from './registry';

export const LANE_ZOMBIE_REAPER_INTERVAL_MS = 5 * 60_000;
export const LANE_HEARTBEAT_STALE_MS = 90_000;

const OWNED_CODEX_ROOT = process.env.CORTEX_IDE_OWNED_CODEX_ROOT
  || path.join(homedir(), '.o8', 'owned-codex');
const OWNED_GEMINI_ROOT = process.env.O8_OWNED_GEMINI_ROOT
  || path.join(homedir(), '.o8', 'owned-gemini');
const OWNED_OPENCODE_ROOT = process.env.O8_OWNED_OPENCODE_ROOT
  || path.join(homedir(), '.o8', 'owned-opencode');

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

async function readOwnedActiveRun(
  surfaceId: string,
  marker: string,
  root: string,
): Promise<{ pid?: number; tmuxSession?: string } | null> {
  if (!surfaceId.startsWith(marker)) return null;
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const metadataPath = path.join(root, entry.name, 'session.json');
      let parsed: { surfaceId?: string; activeRun?: { pid?: number; tmuxSession?: string } };
      try {
        parsed = JSON.parse(await readFile(metadataPath, 'utf-8')) as typeof parsed;
      } catch {
        continue;
      }
      if (parsed.surfaceId !== surfaceId) continue;
      return parsed.activeRun ?? {};
    }
  } catch {
    // Missing registry root means no owned process is currently registered.
  }
  return null;
}

async function probeOwnedSession(
  sessionKey: string,
  marker: string,
  root: string,
): Promise<LaneOwnerProbe> {
  const run = await readOwnedActiveRun(sessionKey, marker, root);
  if (!run) {
    return { alive: false, source: 'owned-session-registry', note: 'owned session metadata not found' };
  }
  if (run.tmuxSession) {
    const alive = await isBridgeSessionAlive(run.tmuxSession);
    return {
      alive,
      source: 'owned-session-registry',
      sessionName: run.tmuxSession,
      pid: run.pid,
    };
  }
  return {
    alive: isPidAlive(run.pid),
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
    return probeOwnedSession(sessionKey, 'codex-owned:', OWNED_CODEX_ROOT);
  }
  if (sessionKey.startsWith('gemini-owned:')) {
    return probeOwnedSession(sessionKey, 'gemini-owned:', OWNED_GEMINI_ROOT);
  }
  if (sessionKey.startsWith('opencode-owned:')) {
    return probeOwnedSession(sessionKey, 'opencode-owned:', OWNED_OPENCODE_ROOT);
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

  const payload = {
    source: options.source,
    force: options.force === true,
    staleMs: candidate.staleMs,
    lastHeartbeatAt: candidate.lastHeartbeatAt,
    previousSessionKey: before.sessionKey,
    processProbe: candidate.probe,
    recommendedAction: before.packetId ? 'retry_packet' : 'inspect_lane',
  };

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
