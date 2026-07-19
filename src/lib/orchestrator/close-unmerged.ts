import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatch } from '@/lib/lane/commands';
import { findLatestLaneByPacket, updateLane } from '@/lib/lane/registry';
import { archiveLaneSessions } from '@/lib/lane/reap-sessions';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { markOutcomeClosedUnmerged } from '@/lib/orchestrator/context-relay';
import { removeMergedWorktree } from '@/lib/orchestrator/worktree-cleanup';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';
// #1570 build fix: the client-safe vocabulary (dispositions, labels, types)
// lives in a server-import-free module so client components can use it without
// dragging this server pipeline (+ its transitive `server-only`) into the bundle.
import {
  CLOSE_UNMERGED_DISPOSITIONS,
  isCloseUnmergedDisposition,
  closeUnmergedDispositionLabel,
  closeUnmergedOutcomeNote,
  type CloseUnmergedDisposition,
  type CloseUnmergedResult,
} from './close-unmerged-shared';

// Re-export the shared vocabulary so existing server-side importers of this
// module keep working unchanged.
export {
  CLOSE_UNMERGED_DISPOSITIONS,
  isCloseUnmergedDisposition,
  closeUnmergedDispositionLabel,
  closeUnmergedOutcomeNote,
};
export type { CloseUnmergedDisposition, CloseUnmergedResult };

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

export async function closePacketUnmerged(input: {
  packetId: string;
  disposition: unknown;
  note: unknown;
}): Promise<CloseUnmergedResult> {
  const rawDisposition = input.disposition ?? 'wontfix';
  if (!isCloseUnmergedDisposition(rawDisposition)) {
    return {
      ok: false,
      code: 'invalid_disposition',
      message: 'disposition must be one of: adopted_elsewhere, superseded, spec_changed, wontfix.',
      status: 400,
    };
  }
  const note = typeof input.note === 'string' ? input.note.trim() : '';
  if (note.length > 1_000) {
    return {
      ok: false,
      code: 'invalid_request',
      message: 'note must be 1,000 characters or fewer.',
      status: 400,
    };
  }

  const lane = findLatestLaneByPacket(input.packetId);
  if (!lane) {
    return {
      ok: false,
      code: 'lane_not_found',
      message: `No lane found for packet ${input.packetId}.`,
      status: 404,
    };
  }
  if (!CLOSEABLE_LANE_STATUSES.has(lane.status)) {
    return {
      ok: false,
      code: 'invalid_packet_state',
      message: `Packet ${input.packetId} cannot close unmerged while its lane is ${lane.status}. Stop or finish the live worker first.`,
      status: 409,
    };
  }

  try {
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
      disposition: rawDisposition,
      note,
      preservedBranch,
    });
    const archived = await dispatch({ verb: 'archive', laneId: lane.id, actor: 'user' });
    if (!archived.ok) {
      return {
        ok: false,
        code: 'close_failed',
        message: archived.note ?? 'Unable to archive the lane.',
        status: 422,
      };
    }
    updateLane(lane.id, {
      outcome: 'closed_unmerged',
      outcomeNote,
    }, 'user');

    try {
      await archiveLaneSessions([lane]);
    } catch (sessionCleanupError) {
      console.warn(`[discard-packet] session cleanup failed for lane ${lane.id}:`, sessionCleanupError);
    }

    let worktreeRemoved = false;
    try {
      const cleanup = await removeMergedWorktree(lane);
      worktreeRemoved = cleanup.removed;
    } catch (cleanupError) {
      console.warn(`[discard-packet] worktree cleanup failed for lane ${lane.id}:`, cleanupError);
    }

    const closedAt = new Date().toISOString();
    await withLockedState((state) => {
      const packet = state.packets.find((candidate) => candidate.id === input.packetId);
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
      packetId: input.packetId,
      disposition: rawDisposition,
      lane,
      summary: outcomeNote,
    });

    void requestRealtimeRefresh({
      targets: ['global', 'mobileInbox'],
      fresh: true,
      reason: 'packet.close_unmerged',
    });

    return {
      ok: true,
      result: {
        closed: true,
        discarded: true,
        disposition: rawDisposition,
        laneId: lane.id,
        packetId: input.packetId,
        worktreeRemoved,
        preservedBranch,
        note: `${outcomeNote}${worktreeRemoved ? ' Worktree removed.' : ''}`,
      },
    };
  } catch (error) {
    return {
      ok: false,
      code: 'close_failed',
      message: error instanceof Error ? error.message : 'Unable to close packet unmerged.',
      status: 500,
      error,
    };
  }
}
