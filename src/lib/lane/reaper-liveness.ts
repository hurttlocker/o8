/**
 * Secondary liveness gates for the lane zombie reaper (#1585).
 *
 * WHY THIS EXISTS — the fleet-wipe root cause.
 * The lane heartbeat (`lastHeartbeatAt`) is written ONLY when a dispatched worker
 * voluntarily runs `o8 packet heartbeat` — the single caller of the
 * `/api/lanes/:id/heartbeat` route (`recordLaneHeartbeat`). There is NO
 * server-side heartbeat driven by session/transcript activity. So a Codex worker
 * deep in a multi-minute turn stops refreshing its heartbeat well inside the 90s
 * `LANE_HEARTBEAT_STALE_MS` window while it is very much alive and streaming
 * tokens. On 2026-07-18 that froze every worker's heartbeat and the reaper
 * massacred the whole fleet on a single 5-min tick (four documented wipes),
 * aborting live Codex turns as `turn_aborted / interrupted` and deleting session
 * dirs.
 *
 * THE DURABLE FIX — stop trusting the heartbeat as the SOLE liveness signal.
 * Before the reaper classifies a stale-heartbeat lane the owner-probe called dead
 * as a zombie, it must clear BOTH secondary gates here:
 *   1. TRANSCRIPT ACTIVITY — the owned-session run log (`runs/*.jsonl`) mtime is
 *      the real streaming pulse; a log written inside the stale window means the
 *      worker is producing output right now → NOT a zombie, regardless of a
 *      frozen heartbeat.
 *   2. LIVE-PROCESS GUARD — `hasLiveProcessInside(worktree)` (reused from the
 *      worktree-pruner fix, d0c14791) answers "does any live process have its cwd
 *      inside this worktree?" via an ANDed `lsof -d cwd +D` query. A detached `codex exec` worker is
 *      exactly this case. It fails CLOSED: any probe uncertainty (error/timeout/
 *      missing binary) reads as "live" so the lane is KEPT — we would rather leak
 *      a stale lane than abort a live worker.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { ownedRoots } from '@/lib/runtimes/shared/owned-session-index';
import { hasLiveProcessInside } from '@/lib/worktree/live-process-guard';
import type { Lane } from './types';

// Source of truth: src/lib/runtimes/shared/owned-session/helpers.ts. Inlined here
// to keep the reaper's startup dependency graph minimal.
const RUNS_DIR = 'runs';
const METADATA_FILE = 'session.json';

/** Resolve the on-disk owned-session dir for a session key (surfaceId). */
async function resolveOwnedSessionDir(sessionKey: string): Promise<string | null> {
  const root = ownedRoots().find((entry) => sessionKey.startsWith(entry.marker))?.root;
  if (!root) return null;

  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    try {
      const raw = await readFile(path.join(dir, METADATA_FILE), 'utf8');
      const parsed = JSON.parse(raw) as { surfaceId?: unknown };
      if (parsed.surfaceId === sessionKey) return dir;
    } catch {
      // Unreadable/parse failure — not this dir; keep scanning.
    }
  }
  return null;
}

/**
 * Newest mtime (ms) among an owned session's transcript run logs, or `null` when
 * the session dir / runs are not resolvable. This is the real streaming pulse:
 * the active run's `runs/<id>.jsonl` is appended on every token the worker emits.
 */
export async function ownedTranscriptMtimeMs(sessionKey: string): Promise<number | null> {
  const sessionDir = await resolveOwnedSessionDir(sessionKey);
  if (!sessionDir) return null;

  const runsDir = path.join(sessionDir, RUNS_DIR);
  let names: string[];
  try {
    names = await readdir(runsDir);
  } catch {
    return null;
  }

  const mtimes = await Promise.all(
    names.map(async (name) => {
      try {
        return (await stat(path.join(runsDir, name))).mtimeMs;
      } catch {
        return null;
      }
    }),
  );
  const valid = mtimes.filter((value): value is number => value !== null);
  return valid.length > 0 ? Math.max(...valid) : null;
}

export interface StaleLaneLivenessDecision {
  /** true → KEEP (not a zombie); false → proceed to reap. */
  keep: boolean;
  source: 'transcript-activity' | 'live-process-guard' | 'stale-liveness' | 'unknown-fail-closed';
  note: string;
  activityAgeMs?: number;
}

/** Injectable probes for real-path/unit tests; production uses the real defaults. */
export interface StaleLaneProbes {
  transcriptMtimeMs?: (sessionKey: string) => Promise<number | null>;
  liveProcessInside?: (worktreePath: string) => Promise<boolean>;
}

/**
 * Decide whether a stale-heartbeat lane the owner-probe already called dead is
 * REALLY a zombie. Returns `keep:true` when ANY of:
 *   - the owned transcript was written within `staleThresholdMs` (fresh streaming)
 *   - a live process has its cwd inside the worktree (`hasLiveProcessInside`)
 *   - the live-process probe is uncertain / throws (fail closed → KEEP)
 * Returns `keep:false` only when both signals cleanly report no life.
 */
export async function assessStaleLaneLiveness(
  lane: Lane,
  opts: { staleThresholdMs: number; now: number; probes?: StaleLaneProbes },
): Promise<StaleLaneLivenessDecision> {
  const { staleThresholdMs, now } = opts;
  const transcriptMtimeMs = opts.probes?.transcriptMtimeMs ?? ownedTranscriptMtimeMs;
  const liveProcessInside = opts.probes?.liveProcessInside ?? hasLiveProcessInside;

  // 1. Transcript activity — the real streaming pulse. Transcript activity IS a
  //    heartbeat: a lane streaming tokens inside the stale window is not a zombie.
  // `hadDeathEvidence` gates the final reap: we only conclude a lane is dead
  // when a probe AFFIRMATIVELY said so (transcript resolved AND stale, or the
  // worktree was probed AND clean). Pure unknown — transcript unresolvable and
  // no worktree to probe — must KEEP (fail closed), never reap (#1585, ginsu
  // review): the upstream owner probe that got us here is exactly the signal
  // proven unreliable for detached workers.
  let hadDeathEvidence = false;

  const sessionKey = lane.sessionKey?.trim();
  if (sessionKey) {
    let mtime: number | null = null;
    try {
      mtime = await transcriptMtimeMs(sessionKey);
    } catch {
      mtime = null;
    }
    if (mtime !== null) {
      const activityAgeMs = now - mtime;
      if (activityAgeMs <= staleThresholdMs) {
        return {
          keep: true,
          source: 'transcript-activity',
          note: 'owned transcript written within the stale window',
          activityAgeMs,
        };
      }
      // Transcript resolved but is older than the window — real death evidence.
      hadDeathEvidence = true;
    }
  }

  // 2. Live-process guard — a worker cwd'd inside the worktree is alive.
  const worktreePath = lane.worktreePath?.trim();
  if (worktreePath) {
    try {
      if (await liveProcessInside(worktreePath)) {
        return {
          keep: true,
          source: 'live-process-guard',
          note: 'live process cwd inside worktree (or probe uncertain — fail closed)',
        };
      }
      // Worktree probed and no live process — corroborating death evidence.
      hadDeathEvidence = true;
    } catch (error) {
      // Fail closed: an unexpected probe throw is uncertainty, not death.
      return {
        keep: true,
        source: 'live-process-guard',
        note: `live-process probe error — keeping fail-closed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  if (!hadDeathEvidence) {
    // No affirmative liveness AND no affirmative death evidence — genuine
    // unknown (unresolvable transcript + no worktree path). Keep fail-closed.
    return {
      keep: true,
      source: 'unknown-fail-closed',
      note: 'no liveness evidence and no death evidence — keeping (unknown, fail closed)',
    };
  }

  return {
    keep: false,
    source: 'stale-liveness',
    note: 'no fresh transcript activity and no live process in worktree',
  };
}
