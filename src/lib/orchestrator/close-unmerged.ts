import { existsSync } from 'node:fs';
import { dispatch } from '@/lib/lane/commands';
import { recordLaneEvent } from '@/lib/lane/events';
import { findLatestLaneByPacket, listLanes, updateLane } from '@/lib/lane/registry';
import { cancelAutoReviewForLane } from '@/lib/lane/review-cancellation';
import { stopActiveReviewTurn } from '@/lib/lane/review-turn-state';
import {
  hasRecordedCleanWorkerExit,
  liveWorkerSessionLanes,
} from '@/lib/lane/worker-session-state';
import {
  archiveLaneSessionsConfirmed,
  killLaneSessionsConfirmed,
  LaneSessionArchiveUnconfirmedError,
} from '@/lib/lane/reap-sessions';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import {
  holdPacketLifecycleMutation,
  markPacketLifecycleFailure,
  mutatePacketLifecycleGuard,
  restorePacketLifecycleGuard,
  type PacketLifecycleGuard,
} from '@/lib/orchestrator/packet-lifecycle-guard';
import { collectPacketLifecycleLanes } from '@/lib/orchestrator/packet-lifecycle-targets';
import { markOutcomeClosedUnmerged } from '@/lib/orchestrator/context-relay';
import { removeMergedWorktree } from '@/lib/orchestrator/worktree-cleanup';
import { runRuntimeAwareWorktreeCleanup } from '@/lib/orchestrator/runtime-worktree-cleanup';
import { formatWorktreeHolderPids } from '@/lib/worktree/holder-diagnostics';
import { requestRealtimeRefresh } from '@/lib/realtime/publisher';
import { unregisterWatchedAgent } from '@/lib/supervisor/agent-supervisor';
// #1570 build fix: the client-safe vocabulary (dispositions, labels, types)
// lives in a server-import-free module so client components can use it without
// dragging this server pipeline (+ its transitive `server-only`) into the bundle.
import {
  CLOSE_UNMERGED_DISPOSITIONS,
  isCloseUnmergedDisposition,
  closeUnmergedDispositionLabel,
  closeUnmergedOutcomeNote,
  type BranchPreservationFailure,
  type BranchPreservationReceipt,
  type CloseUnmergedDisposition,
  type CloseUnmergedResult,
} from './close-unmerged-shared';
import { classifyClosePreservation } from './close-unmerged-preservation';

// Re-export the shared vocabulary so existing server-side importers of this
// module keep working unchanged.
export {
  CLOSE_UNMERGED_DISPOSITIONS,
  isCloseUnmergedDisposition,
  closeUnmergedDispositionLabel,
  closeUnmergedOutcomeNote,
};
export type { CloseUnmergedDisposition, CloseUnmergedResult };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

async function markPacketClosed(
  guard: PacketLifecycleGuard,
  closedAt: string,
  worktreeCleanup: 'missing' | 'removed' | 'preserved',
): Promise<boolean> {
  const closed = await mutatePacketLifecycleGuard(guard, (packet) => {
    packet.status = 'archived';
    packet.queueState = 'held';
    packet.operatorStopped = true;
    packet.releaseState = 'pending';
    packet.releaseStatePayload = null;
    packet.lane = null;
    packet.archivedAt = closedAt;
    packet.blockedReason = null;
    packet.lastEventAt = closedAt;
    packet.lastEventLabel = worktreeCleanup === 'missing'
      ? 'discarded_worktree_missing'
      : 'closed_unmerged';
    return true;
  });
  return closed.matched && closed.result === true;
}

async function closePacketUnmergedUnlocked(input: {
  packetId: string;
  disposition: unknown;
  note: unknown;
  acknowledgeMissingWorktree: boolean;
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

  const guard = await holdPacketLifecycleMutation({ packetId: input.packetId, kind: 'close' });
  if (!guard) {
    return {
      ok: false,
      code: 'packet_not_found',
      message: `Packet ${input.packetId} was not found in current or durable mission state.`,
      status: 404,
    } satisfies CloseUnmergedResult;
  }
  const persistedLanes = listLanes().filter((candidate) => (
    candidate.packetId === input.packetId
    && candidate.status !== 'archived'
    && candidate.status !== 'completed'
  ));
  const lanesToClose = collectPacketLifecycleLanes(
    guard.previousPacket,
    guard.repoPath,
    persistedLanes,
  );
  const lane = lanesToClose.at(-1) ?? findLatestLaneByPacket(input.packetId) ?? null;
  if (!lane) {
    await restorePacketLifecycleGuard(guard);
    return {
      ok: false,
      code: 'lane_not_found',
      message: `No lane or authoritative packet binding found for packet ${input.packetId}.`,
      status: 404,
    };
  }
  const uncloseable = lanesToClose.find((candidate) => !CLOSEABLE_LANE_STATUSES.has(candidate.status));
  if (uncloseable) {
    await restorePacketLifecycleGuard(guard);
    return {
      ok: false,
      code: 'invalid_packet_state',
      message: `Packet ${input.packetId} cannot close unmerged while lane ${uncloseable.id} is ${uncloseable.status}. Stop or finish the live worker first.`,
      status: 409,
    };
  }
  const worktreeRefs = new Map<string, string>();
  for (const target of lanesToClose) {
    if (!target.worktreePath?.trim() || !target.branch.trim()) continue;
    const refKey = `${target.repoPath.replace(/\/+$/, '')}\0${target.branch}`;
    const priorWorktree = worktreeRefs.get(refKey);
    if (priorWorktree && priorWorktree !== target.worktreePath) {
      await restorePacketLifecycleGuard(guard);
      return {
        ok: false,
        code: 'ambiguous_lifecycle_targets',
        message: `Packet ${input.packetId} has multiple worktrees claiming branch ${target.branch}; close was refused so neither checkout is discarded.`,
        status: 409,
      };
    }
    worktreeRefs.set(refKey, target.worktreePath);
  }

  const missingWorktreeBindings = new Set(lanesToClose.flatMap((target) => {
    const worktreePath = target.worktreePath?.trim();
    return worktreePath && !existsSync(worktreePath)
      ? [`${target.id}\0${worktreePath}`]
      : [];
  }));
  try {
    const stoppedReviewTurns = [];
    const reviewedLaneIds = new Set<string>();
    for (const target of lanesToClose) {
      if (reviewedLaneIds.has(target.id)) continue;
      reviewedLaneIds.add(target.id);
      cancelAutoReviewForLane(target.id, 'packet_discarded');
      const stopped = stopActiveReviewTurn({ laneId: target.id, reason: 'packet_discarded' });
      if (stopped) stoppedReviewTurns.push(stopped);
    }

    const kills = await killLaneSessionsConfirmed(liveWorkerSessionLanes(lanesToClose));
    const survivors = kills.filter((outcome) => !outcome.confirmed && !outcome.alreadyDead);
    if (survivors.length > 0) {
      await markPacketLifecycleFailure(guard, 'kill_unconfirmed');
      return {
        ok: false,
        code: 'kill_unconfirmed',
        message: `Close refused because ${survivors.length} worker session class process${survivors.length === 1 ? '' : 'es'} could not be confirmed stopped. The lane and worktree remain intact.`,
        status: 409,
      };
    }
    const unverifiedMissing = lanesToClose.find((target) => {
      const worktreePath = target.worktreePath?.trim();
      if (!worktreePath || !missingWorktreeBindings.has(`${target.id}\0${worktreePath}`)) return false;
      return !input.acknowledgeMissingWorktree && !hasRecordedCleanWorkerExit(target);
    });
    if (unverifiedMissing) {
      await restorePacketLifecycleGuard(guard);
      return {
        ok: false,
        code: 'worktree_missing_unverified',
        message: `Close refused because worktree ${unverifiedMissing.worktreePath} is missing without a recorded clean worker exit. Inspect the packet, then acknowledge the missing worktree to discard it without deleting any path that still exists.`,
        status: 409,
      };
    }

    const preservedBranches: string[] = [];
    const preservationReceipts: BranchPreservationReceipt[] = [];
    let preservationFailure: BranchPreservationFailure | null = null;
    const distinctTargets = [...new Map(lanesToClose
      .filter((target) => target.repoPath.trim() && target.branch.trim())
      .map((target) => [`${target.repoPath}\0${target.branch}`, target] as const)).values()];
    for (const target of distinctTargets) {
      const preservation = await classifyClosePreservation(input.packetId, target);
      preservationReceipts.push(preservation.receipt);
      if (preservation.receipt.reason.startsWith('preserved/')
        && !preservedBranches.includes(preservation.receipt.reason)) {
        preservedBranches.push(preservation.receipt.reason);
      }
      if (preservation.failure) {
        preservationFailure = preservation.failure;
        const auditNote = preservation.failure.code === 'unmerged_work_present'
          ? preservation.failure.message
          : `Preservation FAILED for ${preservation.failure.ref}; the worktree remains intact and close was refused.`;
        recordLaneEvent(target.id, preservation.failure.code === 'branch_preservation_failed'
          ? 'branch_preservation_failed'
          : 'update', 'system', {
          code: preservation.failure.code,
          reason: preservation.failure.reason,
          packetId: input.packetId,
          branch: preservation.failure.branch,
          ref: preservation.failure.ref,
          receipt: preservation.receipt,
          note: auditNote,
          gcRisk: false,
        });
        break;
      }
    }
    if (preservationFailure) {
      await markPacketLifecycleFailure(
        guard,
        preservationFailure.code === 'unmerged_work_present'
          ? 'branch_preservation_failed'
          : preservationFailure.code,
      );
      return {
        ok: false,
        code: preservationFailure.code,
        message: preservationFailure.code === 'unmerged_work_present'
          ? `Close refused because ${preservationFailure.message} The lane and worktree remain intact.`
          : `Close refused because work on ${preservationFailure.branch} could not be preserved. The lane and worktree remain intact.`,
        status: 409,
      };
    }
    const preservedBranch = preservedBranches.length === 1 ? preservedBranches[0] ?? null : null;

    const outcomeNote = closeUnmergedOutcomeNote({
      disposition: rawDisposition,
      note,
      preservedBranch,
      preservedBranches,
      preservationReceipts,
      preservationFailure,
    });
    try {
      await archiveLaneSessionsConfirmed(lanesToClose);
    } catch (error) {
      if (!(error instanceof LaneSessionArchiveUnconfirmedError)) throw error;
      await markPacketLifecycleFailure(guard, 'session_archive_unconfirmed');
      return {
        ok: false,
        code: 'session_archive_unconfirmed',
        message: error.message,
        status: 409,
      };
    }
    for (const candidate of lanesToClose) {
      if (candidate.sessionKey?.trim()) unregisterWatchedAgent(candidate.sessionKey.trim());
    }
    let worktreeRemoved = false;
    for (const candidate of lanesToClose) {
      const worktreePath = candidate.worktreePath?.trim();
      if (worktreePath && missingWorktreeBindings.has(`${candidate.id}\0${worktreePath}`)) {
        continue;
      }
      try {
        const cleanupAttempt = await runRuntimeAwareWorktreeCleanup({
          runtime: candidate.runtime,
          worktreePath: candidate.worktreePath,
          cleanup: () => removeMergedWorktree(candidate),
          removed: (result) => result.removed || result.reason === 'worktree-equals-repo',
        });
        const cleanup = cleanupAttempt.result;
        const intentionalMainCheckout = cleanup.reason === 'worktree-equals-repo';
        if (!cleanup.removed && !intentionalMainCheckout) {
          await markPacketLifecycleFailure(guard, 'worktree_cleanup_failed');
          return {
            ok: false,
            code: 'close_failed',
            message: `Close refused because worktree cleanup for lane ${candidate.id} was not confirmed (${cleanup.reason ?? 'unknown'}). The packet remains held and the checkout remains visible.${formatWorktreeHolderPids(cleanupAttempt.holderPids)}`,
            status: 409,
          };
        }
        worktreeRemoved = cleanup.removed || worktreeRemoved;
      } catch (cleanupError) {
        await markPacketLifecycleFailure(guard, 'worktree_cleanup_failed');
        return {
          ok: false,
          code: 'close_failed',
          message: `Close refused because worktree cleanup for lane ${candidate.id} failed. The packet remains held and the checkout remains visible: ${errorMessage(cleanupError)}`,
          status: 409,
        };
      }
    }
    const primaryWorktreePath = lane.worktreePath?.trim();
    const worktreeCleanup = primaryWorktreePath
      && missingWorktreeBindings.has(`${lane.id}\0${primaryWorktreePath}`)
      ? 'missing' as const
      : worktreeRemoved
        ? 'removed' as const
        : 'preserved' as const;
    const persistedIds = new Set(persistedLanes.map((candidate) => candidate.id));
    for (const candidate of lanesToClose.filter((target) => persistedIds.has(target.id))) {
      const archived = await dispatch({
        verb: 'archive',
        laneId: candidate.id,
        outcome: 'closed_unmerged',
        outcomeNote,
        actor: 'user',
      });
      if (!archived.ok) {
        await markPacketLifecycleFailure(guard, 'lane_archive_failed');
        return {
          ok: false,
          code: 'close_failed',
          message: archived.note ?? `Unable to archive lane ${candidate.id}.`,
          status: 422,
        };
      }
      const candidateWorktreePath = candidate.worktreePath?.trim();
      const candidateCleanup = candidateWorktreePath
        && missingWorktreeBindings.has(`${candidate.id}\0${candidateWorktreePath}`)
        ? 'missing'
        : worktreeRemoved ? 'removed' : 'preserved';
      const eventLabel = candidateCleanup === 'missing'
        ? 'discarded_worktree_missing'
        : 'closed_unmerged';
      updateLane(candidate.id, {
        lastEventAt: new Date().toISOString(),
        lastEventLabel: eventLabel,
      }, 'user', {
        eventLabel,
        packetId: input.packetId,
        worktreeCleanup: candidateCleanup,
        reason: candidateCleanup === 'missing' ? 'worktree_missing' : 'close_unmerged',
        acknowledgedMissingWorktree: input.acknowledgeMissingWorktree,
      });
      recordLaneEvent(candidate.id, 'packet_discarded', 'user', {
        packetId: input.packetId,
        disposition: rawDisposition,
        worktreeCleanup: candidateCleanup,
        reason: candidateCleanup === 'missing' ? 'worktree_missing' : 'close_unmerged',
        acknowledgedMissingWorktree: input.acknowledgeMissingWorktree,
        stoppedReviewTurns: stoppedReviewTurns.length,
      });
    }

    const closedAt = new Date().toISOString();
    if (!await markPacketClosed(guard, closedAt, worktreeCleanup)) {
      return {
        ok: false,
        code: 'close_failed',
        message: `Packet ${input.packetId} disappeared before its closed state could be persisted.`,
        status: 409,
      };
    }
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
        worktreeCleanup,
        stoppedReviewTurns: stoppedReviewTurns.length,
        preservedBranch,
        preservedBranches,
        preservationReceipts,
        preservationFailure,
        note: `${outcomeNote}${worktreeCleanup === 'missing'
          ? ' Worktree was already missing; close recorded worktree_missing.'
          : worktreeRemoved ? ' Worktree removed.' : ''}${stoppedReviewTurns.length > 0
          ? ` Stopped ${stoppedReviewTurns.length} active review turn${stoppedReviewTurns.length === 1 ? '' : 's'} before close.`
          : ''}`,
      },
    };
  } catch (error) {
    await markPacketLifecycleFailure(guard, 'close_failed');
    return {
      ok: false,
      code: 'close_failed',
      message: error instanceof Error ? error.message : 'Unable to close packet unmerged.',
      status: 500,
      error,
    };
  }
}

export function closePacketUnmerged(input: {
  packetId: string;
  disposition: unknown;
  note: unknown;
  acknowledgeMissingWorktree?: boolean;
}): Promise<CloseUnmergedResult> {
  return withPacketLifecycleMutationLock(input.packetId, async ({ contended }) => {
    if (contended) {
      return {
        ok: false,
        code: 'packet_state_changed',
        message: `Packet ${input.packetId} changed while another lifecycle action was in progress; close was not applied.`,
        status: 409,
      };
    }
    return closePacketUnmergedUnlocked({
      ...input,
      acknowledgeMissingWorktree: input.acknowledgeMissingWorktree === true,
    });
  });
}
