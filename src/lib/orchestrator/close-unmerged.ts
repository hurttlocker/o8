import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dispatch } from '@/lib/lane/commands';
import { recordLaneEvent } from '@/lib/lane/events';
import { findLatestLaneByPacket, listLanes, updateLane } from '@/lib/lane/registry';
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

async function preserveCloseTarget(
  packetId: string,
  lane: Parameters<typeof removeMergedWorktree>[0] & { branch: string },
): Promise<{ branch: string | null; failure: BranchPreservationFailure | null }> {
  if (!lane.worktreePath || !lane.branch || !lane.repoPath) {
    return { branch: null, failure: null };
  }
  const preservedRef = `refs/heads/${lane.branch}`;
  let failure: BranchPreservationFailure | null = null;
  try {
    await execFileAsync('git', ['fetch', lane.worktreePath, `${lane.branch}:refs/heads/${lane.branch}`], {
      windowsHide: true,
      cwd: lane.repoPath,
      timeout: 30_000,
    });
    try {
      await execFileAsync('git', ['show-ref', '--verify', preservedRef], {
        windowsHide: true,
        cwd: lane.repoPath,
        timeout: 10_000,
      });
    } catch (verifyError) {
      failure = {
        code: 'branch_preservation_failed',
        reason: 'ref_verification_failed',
        branch: lane.branch,
        ref: preservedRef,
        message: errorMessage(verifyError),
      };
    }
  } catch (preserveError) {
    failure = {
      code: 'branch_preservation_failed',
      reason: 'ref_write_failed',
      branch: lane.branch,
      ref: preservedRef,
      message: errorMessage(preserveError),
    };
  }
  if (!failure) return { branch: lane.branch, failure: null };

  const auditNote = `Preservation FAILED for ${failure.ref}; the worktree remains intact and close was refused.`;
  console.error(
    `[discard-packet] ${auditNote} lane=${lane.id} reason=${failure.reason}`,
    failure.message,
  );
  try {
    recordLaneEvent(lane.id, 'branch_preservation_failed', 'system', {
      code: failure.code,
      reason: failure.reason,
      packetId,
      branch: failure.branch,
      ref: failure.ref,
      note: auditNote,
      gcRisk: false,
    });
  } catch (error) {
    console.warn(`[discard-packet] Could not record branch preservation failure for ${lane.id}:`, error);
  }
  return { branch: null, failure };
}

async function markPacketClosed(guard: PacketLifecycleGuard, closedAt: string): Promise<boolean> {
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
    packet.lastEventLabel = 'closed_unmerged';
    return true;
  });
  return closed.matched && closed.result === true;
}

async function closePacketUnmergedUnlocked(input: {
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

  try {
    const kills = await killLaneSessionsConfirmed(lanesToClose);
    const survivors = kills.filter((outcome) => !outcome.confirmed && !outcome.alreadyDead);
    if (survivors.length > 0) {
      await markPacketLifecycleFailure(guard, 'kill_unconfirmed');
      return {
        ok: false,
        code: 'kill_unconfirmed',
        message: 'Close refused because the worker process could not be confirmed stopped. The lane and worktree remain intact.',
        status: 409,
      };
    }

    const preservedBranches: string[] = [];
    let preservationFailure: BranchPreservationFailure | null = null;
    const distinctTargets = [...new Map(lanesToClose
      .filter((target) => target.worktreePath?.trim() && target.branch.trim())
      .map((target) => [`${target.repoPath}\0${target.worktreePath}\0${target.branch}`, target] as const)).values()];
    for (const target of distinctTargets) {
      const preservation = await preserveCloseTarget(input.packetId, target);
      if (preservation.branch && !preservedBranches.includes(preservation.branch)) {
        preservedBranches.push(preservation.branch);
      }
      if (preservation.failure) {
        preservationFailure = preservation.failure;
        break;
      }
    }
    if (preservationFailure) {
      await markPacketLifecycleFailure(guard, 'branch_preservation_failed');
      return {
        ok: false,
        code: 'branch_preservation_failed',
        message: `Close refused because work on ${preservationFailure.branch} could not be preserved. The lane and worktree remain intact.`,
        status: 409,
      };
    }
    const preservedBranch = preservedBranches.length === 1 ? preservedBranches[0] ?? null : null;

    const outcomeNote = closeUnmergedOutcomeNote({
      disposition: rawDisposition,
      note,
      preservedBranch,
      preservedBranches,
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
      try {
        const cleanup = await removeMergedWorktree(candidate);
        const intentionalMainCheckout = cleanup.reason === 'worktree-equals-repo';
        if (!cleanup.removed && !intentionalMainCheckout) {
          await markPacketLifecycleFailure(guard, 'worktree_cleanup_failed');
          return {
            ok: false,
            code: 'close_failed',
            message: `Close refused because worktree cleanup for lane ${candidate.id} was not confirmed (${cleanup.reason ?? 'unknown'}). The packet remains held and the checkout remains visible.`,
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
    const persistedIds = new Set(persistedLanes.map((candidate) => candidate.id));
    for (const candidate of lanesToClose.filter((target) => persistedIds.has(target.id))) {
      const archived = await dispatch({ verb: 'archive', laneId: candidate.id, actor: 'user' });
      if (!archived.ok) {
        await markPacketLifecycleFailure(guard, 'lane_archive_failed');
        return {
          ok: false,
          code: 'close_failed',
          message: archived.note ?? `Unable to archive lane ${candidate.id}.`,
          status: 422,
        };
      }
      const updated = updateLane(candidate.id, {
        outcome: 'closed_unmerged',
        outcomeNote,
      }, 'user');
      if (!updated) throw new Error(`Lane ${candidate.id} disappeared while recording its close outcome.`);
    }

    const closedAt = new Date().toISOString();
    if (!await markPacketClosed(guard, closedAt)) {
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
        preservedBranch,
        preservedBranches,
        preservationFailure,
        note: `${outcomeNote}${worktreeRemoved ? ' Worktree removed.' : ''}`,
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
    return closePacketUnmergedUnlocked(input);
  });
}
