import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { dispatch } from '@/lib/lane/commands';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { removeMergedWorktree } from '@/lib/orchestrator/worktree-cleanup';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

const execFileAsync = promisify(execFile);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orchestrator/discard-packet — operator-only "dismiss it" for a parked
 * packet with nowhere to go (a rejected best-effort hygiene lane, a stale
 * zombie). This is a SOFT dismiss (Q ruling 2026-07-11), not a hard delete:
 *   1. Preserve the committed work as a branch ref in the MAIN repo (imported
 *      from the worktree clone) so the orchestrator can re-adopt it later.
 *   2. Remove the worktree clone to free disk.
 *   3. Archive the lane so it leaves the active set + review beacon.
 * The recovery step that was missing: reset requeues (re-runs the work), merge
 * needs an approval — neither DISMISSES. A worker cannot call this (§HIGH-4).
 *
 * Unlike merge, discard is intentionally NOT gated on review verdict — the
 * point is to clear something the operator has decided isn't going forward now.
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  if (resolveRequestPrincipal(request) !== 'operator') {
    return operatorError('forbidden', 'Discarding packets is operator-only; a dispatched worker cannot call this.', 403);
  }

  const body = await parseJsonBody(request);
  const record = asRecord(body);
  if (!record) {
    return operatorError('invalid_request', 'Invalid JSON body.', 400);
  }

  const packetId = typeof record.packetId === 'string' ? record.packetId.trim() : '';
  if (!packetId) {
    return operatorError('invalid_request', 'packetId is required.', 400);
  }

  const lane = findLatestLaneByPacket(packetId);
  if (!lane) {
    return operatorError('lane_not_found', `No lane found for packet ${packetId}.`, 404);
  }

  try {
    // Step 1 — preserve the committed work as a branch ref in the MAIN repo,
    // imported from the worktree clone, BEFORE we remove the clone. Best-effort:
    // a preservation miss must not block the dismiss (the operator wants it
    // cleared), but when it succeeds the work is recoverable via `lane.branch`.
    let preservedBranch: string | null = null;
    if (lane.worktreePath && lane.branch && lane.repoPath) {
      try {
        await execFileAsync('git', ['fetch', lane.worktreePath, `${lane.branch}:refs/heads/${lane.branch}`], {
          cwd: lane.repoPath,
          timeout: 30_000,
        });
        preservedBranch = lane.branch;
      } catch (preserveError) {
        console.warn(`[discard-packet] branch preservation failed for lane ${lane.id} (${lane.branch}):`, preserveError);
      }
    }

    const result = await dispatch({ verb: 'archive', laneId: lane.id, actor: 'user' });
    if (!result.ok) {
      return operatorError('discard_failed', result.note ?? 'Unable to archive the lane.', 422);
    }

    // Step 2 — free the worktree clone's disk. The commits already live on the
    // preserved branch ref (step 1), so removing the clone doesn't lose the work.
    let worktreeRemoved = false;
    try {
      const cleanup = await removeMergedWorktree(lane);
      worktreeRemoved = cleanup.removed;
    } catch (cleanupError) {
      console.warn(`[discard-packet] worktree cleanup failed for lane ${lane.id}:`, cleanupError);
    }

    void requestRealtimeRefresh({
      targets: ['global', 'mobileInbox'],
      fresh: true,
      reason: 'packet.discard',
    });

    return operatorSuccess({
      discarded: true,
      laneId: lane.id,
      packetId,
      worktreeRemoved,
      preservedBranch,
      note: preservedBranch
        ? `Dismissed packet ${packetId} — work preserved on branch ${preservedBranch}; the orchestrator can re-adopt it.`
        : `Dismissed packet ${packetId} — lane archived${worktreeRemoved ? ' and worktree removed' : ''}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to discard packet.';
    return operatorError('discard_failed', message, 500, error);
  }
}
