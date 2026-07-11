import { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { dispatch } from '@/lib/lane/commands';
import { findLatestLaneByPacket } from '@/lib/lane/registry';
import { removeMergedWorktree } from '@/lib/orchestrator/worktree-cleanup';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';
import { asRecord, operatorError, operatorSuccess, parseJsonBody } from '../_utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/orchestrator/discard-packet — operator-only "kill it" for a parked
 * packet with nowhere to go (a rejected best-effort hygiene lane, a stale
 * zombie). Archives the lane so it leaves the active set + review beacon, then
 * cleans up its isolated worktree. This is the recovery step that was missing
 * (Q ruling 2026-07-11): reset requeues (re-runs the work), merge needs an
 * approval — neither DISCARDS. A worker cannot call this (§HIGH-4).
 *
 * Unlike merge, discard is intentionally NOT gated on review verdict — the
 * point is to clear something the operator has decided is dead.
 */
export async function POST(request: NextRequest) {
  const denied = requirePanelAuth(request);
  if (denied) return denied;

  if (resolveRequestPrincipal(request) === 'worker') {
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
    const result = await dispatch({ verb: 'archive', laneId: lane.id, actor: 'user' });
    if (!result.ok) {
      return operatorError('discard_failed', result.note ?? 'Unable to archive the lane.', 422);
    }

    // Best-effort worktree cleanup — a cleanup miss must NOT fail the discard;
    // the worktree reaper sweeps detached worktrees on its own cadence.
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
      note: `Discarded packet ${packetId} — lane archived${worktreeRemoved ? ' and worktree removed' : ''}.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to discard packet.';
    return operatorError('discard_failed', message, 500, error);
  }
}
