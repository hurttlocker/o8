import { resolve } from 'node:path';

import { checkPruneGate } from './prune-gate';
import { markLaneWorktreeOrphaned } from './orphaned-lane';
import { getWorktreeManager } from '@/lib/worktree/launch';
import { readManagedWorkspaceMaterialization } from '@/lib/workspace/managed-materialization-identity';

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * #2144 — a removal that goes through while the owning lane is still open
 * leaves that lane pointing at a path that no longer exists. The prune gate
 * refuses most of those, but an operator force gets through by design, and the
 * already-absent branch below never consulted a lane at all. Stamp the lane at
 * removal time rather than letting it fail at render an hour later. The lane's
 * STATUS is untouched: an escalated lane is still blocked on a human.
 */
function markOwningLaneOrphaned(laneId: string | undefined, logPrefix: string) {
  if (!laneId) return;
  try {
    if (markLaneWorktreeOrphaned(laneId)) {
      console.warn(`[${logPrefix}] Lane ${laneId} is still open and its worktree was removed — marked orphaned.`);
    }
  } catch (error) {
    console.warn(`[${logPrefix}] failed to mark lane ${laneId} orphaned: ${formatError(error)}`);
  }
}

export async function removeCortexWorktreePath(input: {
  repoRoot: string;
  worktreePath: string;
  laneId?: string;
  logPrefix?: string;
  /** Operator/recovery override — deletes past the prune gate (records `prune_forced`). */
  operatorForce?: boolean;
  /** Set by callers (e.g. cleanupLaneWorktree) that already ran the prune gate. */
  skipPruneGate?: boolean;
  /** Caller already confirmed the bound session process exited. */
  overrideLiveGuard?: true;
}): Promise<boolean> {
  const logPrefix = input.logPrefix ?? 'lane-worktree';
  const label = input.laneId ? ` for lane ${input.laneId}` : '';

  // #1404 — never remove (or prune from) a path that IS the repo root. A
  // null/empty/degenerate worktree path must fail closed, not fall back to
  // destroying the operator's checkout.
  const resolvedTarget = resolve(input.worktreePath ?? '');
  if (!input.worktreePath?.trim() || resolvedTarget === resolve(input.repoRoot)) {
    console.error(`[${logPrefix}] REFUSED removal of ${JSON.stringify(input.worktreePath)}${label} — equals repo root or empty (repo-root write guard, #1404)`);
    return false;
  }

  // Prune-safety gate (Rock 1 item 3): refuse a tree with uncommitted work /
  // recent activity / a non-terminal lane unless the caller already gated or
  // explicitly forces. This is the check the force path historically lacked —
  // the one that ate two worktrees mid-surgery (#1498).
  if (!input.skipPruneGate) {
    const gate = await checkPruneGate({
      repoRoot: input.repoRoot,
      worktreePath: input.worktreePath,
      laneId: input.laneId ?? null,
      logPrefix,
      operatorForce: input.operatorForce,
    });
    if (!gate.ok) {
      console.warn(`[${logPrefix}] REFUSED removal of ${JSON.stringify(input.worktreePath)}${label} — prune gate: ${gate.reason}`);
      return false;
    }
  }

  try {
    const managed = await readManagedWorkspaceMaterialization(input.repoRoot, input.worktreePath);
    const removed = await getWorktreeManager(input.repoRoot).cleanup(managed.metadata.id, {
      force: input.operatorForce,
      deleteBranch: false,
      overrideLiveGuard: input.overrideLiveGuard,
    });
    if (removed) markOwningLaneOrphaned(input.laneId, logPrefix);
    return removed;
  } catch (error) {
    console.warn(`[${logPrefix}] Retaining ${input.worktreePath}${label}: exact manager retirement refused (${formatError(error)}).`);
    return false;
  }
}
