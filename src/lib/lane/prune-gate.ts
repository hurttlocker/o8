/**
 * Prune gate (Rock 1 item 3) — the ONE guard every worktree/clone deletion
 * path must pass before removing a directory.
 *
 * Two dogfood incidents motivated it:
 *   - #1498: a sweep recursed a 20GB `.cortex-worktrees` clone farm and, worse,
 *     the force removal path had NO dirty check — it ate two worktrees mid-
 *     surgery while an agent was still editing them.
 *   - #1497: an app restart's orphan sweep archived running packets and pruned
 *     worktrees holding ~120 uncommitted insertions each.
 *
 * The gate refuses when ANY of these hold (and the lifecycle hasn't confirmed
 * the lane is finished):
 *   - uncommitted work is present (`git status --porcelain`), OR
 *   - any file in a BOUNDED sample of the tree was modified within
 *     PRUNE_RECENT_MTIME_MS (a live agent still writing), OR
 *   - the owning lane is non-terminal (deleting out from under live work).
 *
 * A CONFIRMED lane-terminal owning lane (failed/completed/archived) waives the
 * dirty/recent checks: its recent writes are the just-finished merge/preserve,
 * not a live agent, and terminal cleanup callers preserve the head separately
 * before deleting. When there is no owning lane at all (raw clone removal), the
 * dirty/recent checks are the whole protection.
 *
 * The mtime probe is DELIBERATELY bounded — never a recursive walk (that was the
 * #1498 event-loop wedge). It samples the worktree root, `.git/HEAD`, the
 * git-tracked top-level entries, the paths named by `git status`, and the
 * immediate (depth-1) children — skipping `node_modules`/`.git` internals.
 *
 * Refusals emit a `prune_refused` lane event (or a `[prune-gate]` console line
 * when there is no lane). An explicit `operatorForce` still deletes but emits
 * `prune_forced` so the override is on the audit trail.
 */

import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { isLaneTerminal } from './terminal-states';

const execFileAsync = promisify(execFile);

export const PRUNE_RECENT_MTIME_MS = 30 * 60_000; // 30 min
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 4 * 1024 * 1024;
const MAX_SAMPLE = 200; // hard cap on stat() calls — bounded, never a full walk
const MAX_PER_SOURCE = 60;

export interface PruneGateInput {
  repoRoot: string;
  worktreePath: string;
  laneId?: string | null;
  logPrefix?: string;
  /** Operator/recovery override — deletes anyway but records `prune_forced`. */
  operatorForce?: boolean;
}

export interface PruneGateDecision {
  ok: boolean;
  /** Comma-joined structured reasons when blocked (or overridden). */
  reason?: string;
  /** True when `ok` only because `operatorForce` overrode a real block. */
  forced?: boolean;
}

async function gitStatusPorcelain(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'status', '--porcelain'], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout;
  } catch {
    return null; // not a git worktree / git unavailable — no uncommitted signal
  }
}

async function gitTrackedTopLevel(worktreePath: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', worktreePath, 'ls-tree', '--name-only', 'HEAD'], {
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
    return stdout.split('\n').map((line) => line.trim()).filter(Boolean).slice(0, MAX_PER_SOURCE);
  } catch {
    return [];
  }
}

function statusPaths(porcelain: string | null): string[] {
  if (!porcelain) return [];
  const paths: string[] = [];
  for (const line of porcelain.split('\n').slice(0, MAX_PER_SOURCE)) {
    const raw = line.slice(3).trim();
    if (!raw) continue;
    // Rename lines are `old -> new`; the new path is what exists on disk.
    paths.push(raw.includes(' -> ') ? raw.split(' -> ').pop()!.trim() : raw);
  }
  return paths;
}

/**
 * Bounded recent-activity probe. Returns true when any sampled file's mtime is
 * newer than the cutoff. NEVER recurses.
 */
async function hasRecentActivity(
  worktreePath: string,
  now: number,
  porcelain: string | null,
): Promise<boolean> {
  const cutoff = now - PRUNE_RECENT_MTIME_MS;
  const candidates = new Set<string>();
  candidates.add(worktreePath);
  candidates.add(join(worktreePath, '.git', 'HEAD'));
  candidates.add(join(worktreePath, '.git'));

  for (const name of await gitTrackedTopLevel(worktreePath)) candidates.add(join(worktreePath, name));
  for (const rel of statusPaths(porcelain)) candidates.add(join(worktreePath, rel));

  try {
    const entries = await readdir(worktreePath, { withFileTypes: true });
    for (const entry of entries.slice(0, MAX_PER_SOURCE)) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      candidates.add(join(worktreePath, entry.name));
    }
  } catch {
    /* dir gone / unreadable — nothing to sample */
  }

  let sampled = 0;
  for (const candidate of candidates) {
    if (sampled >= MAX_SAMPLE) break;
    sampled += 1;
    try {
      const info = await stat(candidate);
      if (info.mtimeMs > cutoff) return true;
    } catch {
      /* missing path — skip */
    }
  }
  return false;
}

async function emitPruneEvent(
  input: PruneGateInput,
  lane: { id: string } | null,
  verb: 'prune_refused' | 'prune_forced',
  reason: string,
): Promise<void> {
  const prefix = input.logPrefix ?? 'prune-gate';
  if (lane) {
    try {
      const { appendEvent } = await import('./registry');
      appendEvent(lane.id, verb, 'system', {
        worktreePath: input.worktreePath,
        reason,
        forced: verb === 'prune_forced',
      });
      return;
    } catch (error) {
      console.warn(`[${prefix}] failed to append ${verb} event for lane ${lane.id}:`, error);
    }
  }
  const line = `[prune-gate] ${verb} ${JSON.stringify(input.worktreePath)} (${reason})`;
  if (verb === 'prune_refused') console.warn(line);
  else console.log(line);
}

/**
 * Decide whether a worktree/clone may be removed. Returns `{ ok: false, reason }`
 * on refusal (having emitted `prune_refused`), `{ ok: true }` on a clean allow,
 * or `{ ok: true, forced: true, reason }` when `operatorForce` overrode a block
 * (having emitted `prune_forced`).
 */
export async function checkPruneGate(input: PruneGateInput): Promise<PruneGateDecision> {
  const worktreePath = input.worktreePath?.trim();
  if (!worktreePath) {
    // Never delete an empty/degenerate path — fail closed.
    await emitPruneEvent(input, null, 'prune_refused', 'empty_path');
    return { ok: false, reason: 'empty_path' };
  }

  let lane: { id: string; status: string } | null = null;
  if (input.laneId) {
    try {
      const { getLane } = await import('./registry');
      lane = getLane(input.laneId);
    } catch {
      lane = null;
    }
  }
  const laneTerminal = lane ? isLaneTerminal(lane.status as never) : false;

  const reasons: string[] = [];
  if (lane && !laneTerminal) reasons.push('lane_non_terminal');
  if (!laneTerminal) {
    const porcelain = await gitStatusPorcelain(worktreePath);
    if (porcelain !== null && porcelain.trim().length > 0) reasons.push('uncommitted_work');
    if (await hasRecentActivity(worktreePath, Date.now(), porcelain)) reasons.push('recent_activity');
  }

  if (reasons.length === 0) return { ok: true };

  const reason = reasons.join(',');
  if (input.operatorForce) {
    await emitPruneEvent(input, lane, 'prune_forced', reason);
    return { ok: true, forced: true, reason };
  }
  await emitPruneEvent(input, lane, 'prune_refused', reason);
  return { ok: false, reason };
}
