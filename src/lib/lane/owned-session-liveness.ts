/**
 * Shared owned-session liveness probe (Recovery layer v2, 2026-07-08).
 *
 * The lane zombie reaper (`reaper.ts`, 5-min tick) and the silent-exit detector
 * (`silent-exit-detector.ts`, 30-s tick) each carried a near-identical ~80-line
 * copy of "is this owned worker session still alive?" — `probeOwnedSession`
 * (reaper) and `isOwnedSessionAlive` (silent-exit), plus their own copies of
 * `isPidAlive` and the codex-worktree continuity check. Two copies meant two
 * places for the policy to drift. This module is the single source of truth;
 * both ticks now delegate here.
 *
 * RECONCILED DIVERGENCE (the two copies were byte-identical except one branch):
 *   pid recorded but now dead, no tmux session to confirm, no codex worktree
 *   continuity → reaper returned `{alive:false}` (definitively dead); silent-exit
 *   returned `undefined` (can't tell — bail rather than miscategorize). This
 *   module adopts the STRICTER/safer silent-exit behavior: `undefined`. The
 *   reaper's candidate filter treats `alive !== false` as "not a candidate", so
 *   a pid-dead-no-tmux owned lane is no longer reaped on that same tick — but the
 *   owned-session store clears `activeRun` on its next pass (see owned-session
 *   store), which this probe reads as `{}` → `{alive:false}`, so the reap is
 *   delayed by one store-cleanup cycle, never blocked. Net effect: the reaper
 *   never yanks a lane whose only death-evidence was a stale pid with no tmux.
 */
import { isBridgeSessionAlive } from '@/lib/runtime/pty-bridge';
import { findLiveCodexProcessByCwd } from '@/lib/runtimes/shared/codex-process-cwd';
import { lookupOwnedActiveRun } from '@/lib/runtimes/shared/owned-session-index';
import type { Lane } from './types';

/**
 * Result of an owned-session liveness probe. `alive` is a tri-state:
 *   - `true`   — session is confidently alive
 *   - `false`  — session is confidently dead
 *   - `undefined` — cannot tell; callers MUST NOT treat this as dead.
 */
export interface OwnedSessionProbe {
  alive: boolean | undefined;
  source: string;
  pid?: number;
  sessionName?: string;
  note?: string;
}

/** Owned-worker session-key prefixes, one per runtime that spawns IDE-owned sessions. */
export const OWNED_SESSION_PREFIXES = [
  'codex-owned:',
  'claude-code-owned:',
  'gemini-owned:',
  'opencode-owned:',
] as const;

export function isOwnedSessionKey(sessionKey: string): boolean {
  return OWNED_SESSION_PREFIXES.some((prefix) => sessionKey.startsWith(prefix));
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process EXISTS but cannot be signalled — an elevated or
    // other-user worker. Reading it as dead here while the fleet copy reads it
    // as alive gives the two a split-brain: the reaper salvages and archives a
    // lane the fleet still believes is running.
    if ((error as NodeJS.ErrnoException)?.code === 'EPERM') return true;
    return false;
  }
}

/**
 * A dead owned session-key can still be alive if a live codex process is running
 * in the lane's worktree (the wrapper pid went stale after `exec`, but the real
 * process continues). Only codex sessions get this second chance.
 */
async function probeCodexWorktreeContinuity(
  sessionKey: string,
  worktreePath: string | null | undefined,
): Promise<OwnedSessionProbe | null> {
  if (!sessionKey.startsWith('codex-owned:')) return null;
  const match = await findLiveCodexProcessByCwd(worktreePath);
  if (!match) return null;
  return {
    alive: true,
    source: 'codex-process-cwd',
    pid: match.pid,
    note: 'live codex process cwd matches lane worktree',
  };
}

/**
 * Probe an owned (`*-owned:`) worker session. Reads the shared, TTL-memoized
 * owned-session index (one readdir per root per tick, shared across both ticks)
 * to resolve the recorded active run:
 *   - `null` → session metadata not found (gone)
 *   - `{}`   → present but `activeRun` cleared (definitively dead)
 *   - `{pid?, tmuxSession?}` → present with an active run
 *
 * See the module header for the one reconciled behavioral difference.
 */
export async function probeOwnedSessionLiveness(
  sessionKey: string,
  worktreePath: string | null | undefined,
): Promise<OwnedSessionProbe> {
  const run = await lookupOwnedActiveRun(sessionKey);
  if (!run) {
    return (await probeCodexWorktreeContinuity(sessionKey, worktreePath))
      ?? { alive: false, source: 'owned-session-registry', note: 'owned session metadata not found' };
  }
  if (run.tmuxSession === undefined && run.pid === undefined) {
    return (await probeCodexWorktreeContinuity(sessionKey, worktreePath))
      ?? { alive: false, source: 'owned-session-registry', note: 'owned session activeRun cleared' };
  }
  if (run.tmuxSession) {
    // Trust the tmux/bridge session first — it survives `zsh -l -c CMD` exec-ing
    // into the CLI, where the wrapper pid is replaced by the child pid and our
    // stored pid goes stale. tmux alive → session alive regardless of pid; tmux
    // dead → fall back to codex worktree continuity before declaring death.
    const alive = await isBridgeSessionAlive(run.tmuxSession);
    if (!alive) {
      const continuity = await probeCodexWorktreeContinuity(sessionKey, worktreePath);
      if (continuity) return continuity;
    }
    return {
      alive,
      source: 'owned-session-registry',
      sessionName: run.tmuxSession,
      pid: run.pid,
    };
  }
  // No tmux session recorded (e.g. bridge failed to spawn) — fall back to pid.
  if (isPidAlive(run.pid)) {
    return { alive: true, source: 'owned-session-registry', pid: run.pid };
  }
  const continuity = await probeCodexWorktreeContinuity(sessionKey, worktreePath);
  if (continuity) return continuity;
  // Reconciled divergence (see module header): pid was set but is now dead, with
  // no tmux to confirm — bail (`undefined`) rather than miscategorize. The store
  // clears activeRun on its next pass and the `{}` branch above then declares it
  // dead.
  return { alive: undefined, source: 'owned-session-registry', pid: run.pid, note: 'owned session pid dead, no tmux to confirm' };
}

/**
 * Whether any live `claude` CLI process is running in the lane's worktree/repo.
 * The claude-code CLI writes JSONL transcripts owned by the user, so there is no
 * sessionKey→pid mapping; matching a live process cwd is the cheap proxy.
 * `alive: undefined` when we cannot tell (no cwd to compare, or the process scan
 * threw).
 */
export async function probeClaudeCwdAlive(lane: Lane): Promise<OwnedSessionProbe> {
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
    return { alive: Boolean(match), source: 'claude-process-cwd', pid: match?.pid };
  } catch (error) {
    return {
      alive: undefined,
      source: 'claude-process-cwd',
      note: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Outer per-lane liveness verdict used by the silent-exit tick and by the dead-
 * lane archiver's re-probe. Returns `true`/`false` when confident, `undefined`
 * when we should not claim a verdict:
 *   - owned session → {@link probeOwnedSessionLiveness}
 *   - discovered/operator codex terminals (`codex-live:` / `codex:`) → undefined
 *     (never claim liveness on a session the operator drives by hand)
 *   - claude-code runtime → {@link probeClaudeCwdAlive}
 *   - anything else → undefined
 */
export async function probeLaneSessionAlive(lane: Lane): Promise<boolean | undefined> {
  const sessionKey = lane.sessionKey?.trim();
  if (!sessionKey) return undefined;

  if (isOwnedSessionKey(sessionKey)) {
    try {
      return (await probeOwnedSessionLiveness(sessionKey, lane.worktreePath)).alive;
    } catch (error) {
      console.warn(`[lane-lifecycle] Owned session probe failed for ${sessionKey}:`, error);
      return undefined;
    }
  }

  if (sessionKey.startsWith('codex-live:') || sessionKey.startsWith('codex:')) {
    return undefined;
  }

  if (lane.runtime === 'claude-code') {
    return (await probeClaudeCwdAlive(lane)).alive;
  }

  return undefined;
}
