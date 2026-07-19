import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { dispatch } from '@/lib/lane/commands';
import { findLatestLaneByPacket, updateLane } from '@/lib/lane/registry';
import { archiveLaneSessions } from '@/lib/lane/reap-sessions';
import {
  closeUnmergedOutcomeNote,
  isCloseUnmergedDisposition,
  type CloseUnmergedDisposition,
} from '@/lib/orchestrator/close-unmerged';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { markOutcomeClosedUnmerged } from '@/lib/orchestrator/context-relay';
import { removeMergedWorktree } from '@/lib/orchestrator/worktree-cleanup';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

const execFileAsync = promisify(execFile);
const CLOSEABLE_LANE_STATUSES = new Set([
  'idle',
  'paused',
  'awaiting_input',
  'awaiting_orchestrator',
  'awaiting_human',
  'recovering',
  'reviewing',
  'failed',
]);

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orchestrator/discard-packet — operator-only disposition for a
 * packet that intentionally will not merge. This is a SOFT close, not a hard
 * delete:
 *   1. Preserve the committed work as a branch ref in the MAIN repo (imported
 *      from the worktree clone) so the orchestrator can re-adopt it later.
 *   2. Remove the worktree clone to free disk.
 *   3. Archive the lane so it leaves the active set + review beacon.
 * The caller declares why the packet is closing: adopted elsewhere, superseded,
 * spec changed, or won't fix. A worker cannot call this (§HIGH-4).
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

  const rawDisposition = record.disposition ?? record.reason ?? 'wontfix';
  if (!isCloseUnmergedDisposition(rawDisposition)) {
    return operatorError(
      'invalid_disposition',
      'disposition must be one of: adopted_elsewhere, superseded, spec_changed, wontfix.',
      400,
    );
  }
  const disposition: CloseUnmergedDisposition = rawDisposition;
  const note = typeof record.note === 'string' ? record.note.trim() : '';
  if (note.length > 1_000) {
    return operatorError('invalid_request', 'note must be 1,000 characters or fewer.', 400);
  }

  const lane = findLatestLaneByPacket(packetId);
  if (!lane) {
    return operatorError('lane_not_found', `No lane found for packet ${packetId}.`, 404);
  }
  if (!CLOSEABLE_LANE_STATUSES.has(lane.status)) {
    return operatorError(
      'invalid_packet_state',
      `Packet ${packetId} cannot close unmerged while its lane is ${lane.status}. Stop or finish the live worker first.`,
      409,
    );
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

    const outcomeNote = closeUnmergedOutcomeNote({
      disposition,
      note,
      preservedBranch,
    });
    const result = await dispatch({ verb: 'archive', laneId: lane.id, actor: 'user' });
    if (!result.ok) {
      return operatorError('close_failed', result.note ?? 'Unable to archive the lane.', 422);
    }
    updateLane(lane.id, {
      outcome: 'closed_unmerged',
      outcomeNote,
    }, 'user');

    // Retire the owned-session directory after the lane archival succeeds.
    // Leaving an owned dir in the live inventory can rehydrate an intentionally
    // closed packet as a phantom lane on the next app launch.
    try {
      await archiveLaneSessions([lane]);
    } catch (sessionCleanupError) {
      console.warn(`[discard-packet] session cleanup failed for lane ${lane.id}:`, sessionCleanupError);
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

    const closedAt = new Date().toISOString();
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === packetId);
      if (!packet) return;
      packet.status = 'archived';
      packet.queueState = 'held';
      packet.archivedAt = closedAt;
      packet.blockedReason = null;
      packet.lastEventAt = closedAt;
      packet.lastEventLabel = 'closed_unmerged';
    });
    await markOutcomeClosedUnmerged({
      laneId: lane.id,
      packetId,
      disposition,
      lane,
      summary: outcomeNote,
    });

    void requestRealtimeRefresh({
      targets: ['global', 'mobileInbox'],
      fresh: true,
      reason: 'packet.close_unmerged',
    });

    return operatorSuccess({
      closed: true,
      discarded: true,
      disposition,
      laneId: lane.id,
      packetId,
      worktreeRemoved,
      preservedBranch,
      note: `${outcomeNote}${worktreeRemoved ? ' Worktree removed.' : ''}`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to close packet unmerged.';
    return operatorError('close_failed', message, 500, error);
  }
}
