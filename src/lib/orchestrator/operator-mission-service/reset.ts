import { cleanupResetPacketTargets, type ResetCleanupTarget } from './reset-cleanup';
import {
  bindCommittedRetryWork,
  findCommittedRetryWork,
  holdPacketForRetrySalvage,
  markRetrySalvageKillUnconfirmed,
  markRetrySalvageSessionArchiveUnconfirmed,
  retrySalvageGenerationSource,
  retrySalvageGuardIsCurrent,
  RetrySalvageKillUnconfirmedError,
  RetrySalvageStateChangedError,
  scopedPacketGenerationMatches,
  type RetrySalvage,
} from './retry-salvage';
import { log } from './shared';
import type { ResetPacketInput } from './types';
import { LaneSessionArchiveUnconfirmedError } from '@/lib/lane/reap-sessions';
import { removeCortexWorktreePath } from '@/lib/lane/worktree-clone-removal';
import { unregisterWatchedAgent } from '@/lib/supervisor/agent-supervisor';
import {
  findMissionRegistryEntryByPacketId,
  readMissionRegistryEntry,
  withMissionRegistryState,
} from '@/lib/orchestrator/mission-registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { advancePacketStorageAdmissionEpoch } from '@/lib/orchestrator/packet-storage-admission-normalize';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import { supersedeDurableApprovedReviews } from '@/lib/lane/durable-review-approval';
import {
  withMissionHandoffBarrier,
  withPacketLifecycleMutationLock,
} from '@/lib/orchestrator/lifecycle-mutation-lock';
import { collectPacketLifecycleLanes } from '@/lib/orchestrator/packet-lifecycle-targets';
import {
  ResetCleanupFailedError,
  ResetKillUnconfirmedError,
  ResetSessionArchiveUnconfirmedError,
} from './reset-errors';
import {
  archiveResetLaneSessions,
  confirmedKilledLaneIds,
} from './reset-lifecycle-retirement';
import {
  resetPacketViaLaneFallback,
  type ResetAuthoritativeBinding,
} from './reset-lane-fallback';

export {
  ResetCleanupFailedError,
  ResetKillUnconfirmedError,
  ResetSessionArchiveUnconfirmedError,
} from './reset-errors';
export type { ResetCleanupFailureResult } from './reset-errors';

function withinScope(input: ResetPacketInput, laneId: string): boolean {
  return !input.scope || input.scope.laneIds.includes(laneId);
}

function markPacketResetHeld(packet: OrchestratorPacket) {
  // Reset packet to a CLEAN, NON-auto-dispatchable state.
  // #23 — queueState is 'held' (NOT 'queued') so the supervisor's headless
  // dispatch tick does NOT relaunch it on its own. reset is a CLEANUP, not a
  // relaunch — the old reset->queued->supervisor-auto-dispatch "boomerang" spawned
  // surprise agents (even surviving an app restart). An explicit dispatch_mission()
  // promotes held->queued when the operator actually wants to re-launch.
  // #455 — lane MUST be null, not a blank object. A truthy lane with empty laneId
  // causes the reconciler to see "has lane but no domain match" → 'recovering',
  // which races the next dispatch tick and traps the packet in a recovery loop.
  packet.status = 'draft';
  packet.queueState = 'held';
  packet.releaseState = 'pending';
  packet.releaseStatePayload = null;
  packet.archivedAt = null;
  packet.blockedReason = null;
  packet.recovery = null;
  packet.lane = null;
  packet.review = null;
  packet.lastEventAt = null;
  packet.lastEventLabel = null;
  // #455 — Clear recovery counter so a manual reset gives fresh retry budget
  packet.recoveryCount = 0;
  packet.lastRecoveryAt = null;
  // Operator reset also refreshes the typecheck auto-rerun budget (#1108) —
  // this is the ONLY place it resets; rerun_with_feedback preserves it.
  packet.typecheckAutoRetries = 0;
  packet.leaseWaitAutoRetries = 0;
  // Same for the self-review stall budget + the operator-Stop flag (2026-06-22):
  // a reset gives a fresh stall budget and re-enables dispatch.
  packet.stallRetries = 0;
  advancePacketStorageAdmissionEpoch(packet);
  packet.launchAttempts = 0;
  packet.operatorStopped = false;
  packet.tierEscalated = undefined;
}

function markPacketResetPending(packet: OrchestratorPacket) {
  packet.queueState = 'held';
  packet.status = 'blocked';
  packet.operatorStopped = true;
  packet.blockedReason = 'reset_in_progress';
  packet.lastEventAt = new Date().toISOString();
  packet.lastEventLabel = 'reset_in_progress';
}

function markPacketResetKillUnconfirmed(packet: OrchestratorPacket) {
  packet.queueState = 'held';
  packet.status = 'blocked';
  packet.operatorStopped = true;
  packet.blockedReason = 'kill_unconfirmed';
  packet.lastEventAt = new Date().toISOString();
  packet.lastEventLabel = 'kill_unconfirmed';
}

function markPacketResetSessionArchiveUnconfirmed(packet: OrchestratorPacket) {
  packet.queueState = 'held';
  packet.status = 'blocked';
  packet.operatorStopped = true;
  packet.blockedReason = 'session_archive_unconfirmed';
  packet.lastEventAt = new Date().toISOString();
  packet.lastEventLabel = 'session_archive_unconfirmed';
}

function markPacketResetCleanupFailed(packet: OrchestratorPacket) {
  packet.queueState = 'held';
  packet.status = 'blocked';
  packet.operatorStopped = true;
  packet.blockedReason = 'worktree_cleanup_failed';
  packet.lastEventAt = new Date().toISOString();
  packet.lastEventLabel = 'worktree_cleanup_failed';
}

async function selectCurrentPacketForReset(input: ResetPacketInput) {
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { result } = await withLockedState((fresh) => {
    const missionId = fresh.missionId?.trim();
    if (!missionId) return null;
    const packet = fresh.packets.find((candidate) => candidate.id === input.packetId);
    if (!packet) return null;
    if (!input.scope?.skipHoldIfStateMoved) markPacketResetPending(packet);
    return {
      missionId,
      repoPath: fresh.repoPath?.trim() || packet.lane?.repoPath?.trim() || '',
      packet: structuredClone(packet),
    };
  });
  return result;
}

async function selectPacketResetLocation(input: ResetPacketInput) {
  return withMissionHandoffBarrier(async () => {
    const current = await selectCurrentPacketForReset(input);
    if (current) return { kind: 'current' as const, current };

    const registryEntry = findMissionRegistryEntryByPacketId(input.packetId, { includeArchived: true });
    if (!registryEntry) return { kind: 'lane' as const };
    if (!input.scope?.skipHoldIfStateMoved) {
      const { result } = await withMissionRegistryState(registryEntry.id, (state) => {
        const packet = state.packets.find((candidate) => candidate.id === input.packetId);
        if (!packet) throw new Error(`Packet ${input.packetId} not found.`);
        markPacketResetPending(packet);
        return {
          state,
          result: {
            packet: structuredClone(packet),
            repoPath: state.repoPath?.trim() || packet.lane?.repoPath?.trim() || '',
          } satisfies ResetAuthoritativeBinding,
        };
      });
      return {
        kind: 'registry' as const,
        missionId: registryEntry.id,
        authoritative: result,
      };
    }
    const registry = readMissionRegistryEntry(registryEntry.id, { includeArchived: true });
    const packet = registry?.mission.packets.find((candidate) => candidate.id === input.packetId);
    return {
      kind: 'registry' as const,
      missionId: registryEntry.id,
      authoritative: packet ? {
        packet: structuredClone(packet),
        repoPath: registry?.mission.repoPath ?? '',
      } satisfies ResetAuthoritativeBinding : undefined,
    };
  });
}

async function mutateResetPacketGeneration(
  input: ResetPacketInput,
  missionId: string,
  mutate: (packet: OrchestratorPacket) => void,
): Promise<{ referenceLabel: string; stateChanged: boolean } | null> {
  return withMissionHandoffBarrier(() => mutateResetPacketGenerationUnlocked(input, missionId, mutate));
}

async function mutateResetPacketGenerationUnlocked(
  input: ResetPacketInput,
  missionId: string,
  mutate: (packet: OrchestratorPacket) => void,
): Promise<{ referenceLabel: string; stateChanged: boolean } | null> {
  const apply = (packet: OrchestratorPacket) => {
    if (input.scope?.skipHoldIfStateMoved && !scopedPacketGenerationMatches(packet, input)) {
      return { referenceLabel: packet.referenceLabel, stateChanged: true };
    }
    mutate(packet);
    return { referenceLabel: packet.referenceLabel, stateChanged: false };
  };
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { result } = await withLockedState((fresh) => {
    if (fresh.missionId !== missionId) return null;
    const packet = fresh.packets.find((candidate) => candidate.id === input.packetId);
    return packet ? apply(packet) : null;
  });
  if (result) return result;

  if (!readMissionRegistryEntry(missionId, { includeArchived: true })) return null;
  const { result: registryResult } = await withMissionRegistryState(missionId, (state) => {
    const packet = state.packets.find((candidate) => candidate.id === input.packetId);
    return { state, result: packet ? apply(packet) : null };
  });
  return registryResult;
}

async function resetRegistryPacket(
  input: ResetPacketInput,
  missionId: string,
  pendingAlready = false,
  authoritative?: ResetAuthoritativeBinding,
) {
  if (!pendingAlready && !input.scope?.skipHoldIfStateMoved) {
    await withMissionRegistryState(missionId, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === input.packetId);
      if (!packet) throw new Error(`Packet ${input.packetId} not found.`);
      markPacketResetPending(packet);
      return { state, result: undefined };
    });
  }
  await supersedeDurableApprovedReviews(input.packetId, 'Superseded by reset_packet.');
  let worktreePruned = false;
  let branchDeleted = false;
  try {
    const laneReset = await resetPacketViaLaneFallback(input, authoritative);
    worktreePruned = laneReset.worktreePruned;
    branchDeleted = laneReset.branchDeleted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof ResetKillUnconfirmedError) {
      await withMissionRegistryState(missionId, (state) => {
        const packet = state.packets.find((candidate) => candidate.id === input.packetId);
        if (packet && (!input.scope?.skipHoldIfStateMoved || scopedPacketGenerationMatches(packet, input))) {
          markPacketResetKillUnconfirmed(packet);
        }
        return { state, result: undefined };
      });
      throw error;
    }
    if (error instanceof ResetSessionArchiveUnconfirmedError) {
      await withMissionRegistryState(missionId, (state) => {
        const packet = state.packets.find((candidate) => candidate.id === input.packetId);
        if (packet && (!input.scope?.skipHoldIfStateMoved || scopedPacketGenerationMatches(packet, input))) {
          markPacketResetSessionArchiveUnconfirmed(packet);
        }
        return { state, result: undefined };
      });
      throw error;
    }
    if (error instanceof ResetCleanupFailedError) {
      await withMissionRegistryState(missionId, (state) => {
        const packet = state.packets.find((candidate) => candidate.id === input.packetId);
        if (packet && (!input.scope?.skipHoldIfStateMoved || scopedPacketGenerationMatches(packet, input))) {
          markPacketResetCleanupFailed(packet);
        }
        return { state, result: undefined };
      });
      throw error;
    }
    if (!message.includes('no mission packet and no lane')) {
      throw error;
    }
  }

  const { result } = await withMissionRegistryState(missionId, (state) => {
    const packet = state.packets.find((candidate) => candidate.id === input.packetId);
    if (!packet) {
      throw new Error(`Packet ${input.packetId} not found.`);
    }
    if (input.scope?.skipHoldIfStateMoved && !scopedPacketGenerationMatches(packet, input)) {
      return {
        state,
        result: {
          reset: false,
          salvaged: false,
          packetId: input.packetId,
          referenceLabel: packet.referenceLabel,
          worktreePruned,
          branchDeleted,
          note: `Packet ${packet.referenceLabel} moved to a newer generation during reset cleanup; its current state was preserved.`,
        },
      };
    }
    markPacketResetHeld(packet);
    log(`Reset registry packet ${packet.referenceLabel} (${input.packetId}). Reason: ${input.reason ?? 'operator reset'}`);
    return {
      state,
      result: {
        reset: true,
        salvaged: false,
        packetId: input.packetId,
        referenceLabel: packet.referenceLabel,
        worktreePruned,
        branchDeleted,
        note: `Packet ${packet.referenceLabel} reset + held (will NOT auto-redispatch). Old lane archived.${worktreePruned ? ' Worktree pruned.' : ''}${branchDeleted ? ' Branch deleted.' : ''} Call dispatch_mission to re-launch.`,
      },
    };
  });
  return result;
}

async function resetPacketUnlocked(input: ResetPacketInput) {
  const retrySalvageGuard = await holdPacketForRetrySalvage(input);
  let committedRetryWork: Awaited<ReturnType<typeof findCommittedRetryWork>> = null;
  try {
    committedRetryWork = retrySalvageGuard
      ? await findCommittedRetryWork(input, retrySalvageGuard)
      : null;
  } catch (error) {
    if (!(error instanceof RetrySalvageKillUnconfirmedError) || !retrySalvageGuard) throw error;
    await markRetrySalvageKillUnconfirmed(input.packetId, retrySalvageGuard);
    throw new ResetKillUnconfirmedError(error.message);
  }
  if (retrySalvageGuard && committedRetryWork) {
    let retrySalvage: RetrySalvage;
    try {
      retrySalvage = await bindCommittedRetryWork(input, retrySalvageGuard, committedRetryWork);
    } catch (error) {
      if (error instanceof LaneSessionArchiveUnconfirmedError) {
        await markRetrySalvageSessionArchiveUnconfirmed(input.packetId, retrySalvageGuard);
        throw new ResetSessionArchiveUnconfirmedError(error.message);
      }
      if (!(error instanceof RetrySalvageStateChangedError)) throw error;
      log(error.message);
      return {
        reset: false,
        salvaged: false,
        packetId: input.packetId,
        referenceLabel: retrySalvageGuard.referenceLabel,
        worktreePruned: false,
        branchDeleted: false,
        note: error.message,
      };
    }
    await supersedeDurableApprovedReviews(input.packetId, 'Superseded by retry salvage.');
    log(`Retry salvaged committed work for ${retrySalvage.referenceLabel} (${input.packetId}) into lane ${retrySalvage.laneId}.`);
    return {
      reset: false,
      salvaged: true,
      packetId: input.packetId,
      referenceLabel: retrySalvage.referenceLabel,
      worktreePruned: false,
      branchDeleted: false,
      laneId: retrySalvage.laneId,
      note: `Packet ${retrySalvage.referenceLabel} already had a clean committed result. Its existing worktree is preserved and awaiting review; no worker was relaunched.`,
    };
  }
  if (retrySalvageGuard && !await retrySalvageGuardIsCurrent(input.packetId, retrySalvageGuard)) {
    const note = `Packet ${input.packetId} changed while retry salvage was probing; the newer generation was left untouched.`;
    log(note);
    return {
      reset: false,
      salvaged: false,
      packetId: input.packetId,
      referenceLabel: retrySalvageGuard.referenceLabel,
      worktreePruned: false,
      branchDeleted: false,
      note,
    };
  }
  const retryScopedInput = retrySalvageGuard
    ? {
        ...input,
        scope: {
          laneIds: retrySalvageGuard.laneIds,
          skipHoldIfStateMoved: true,
          expectedReleaseSource: retrySalvageGenerationSource(retrySalvageGuard.generation),
        },
      }
    : input;

  const location = await selectPacketResetLocation(retryScopedInput);
  if (location.kind === 'registry') {
    return resetRegistryPacket(
      retryScopedInput,
      location.missionId,
      true,
      location.authoritative,
    );
  }
  if (location.kind === 'lane') {
    return resetPacketViaLaneFallback(retryScopedInput);
  }
  const currentSelection = location.current;
  const { packet, missionId, repoPath } = currentSelection;
  await supersedeDurableApprovedReviews(input.packetId, 'Superseded by reset_packet.');

  // Archive ALL stale lanes bound to this packet and clear their packet
  // binding so the reconciler doesn't re-attach them to this packet OR
  // rebind them to the next new mission that happens to share the same
  // branch slug (v1 ship bug: reconciler was picking up orphan lanes left
  // behind when `packet.lane` was already null in mission state but SQLite
  // still held an active row tied to `packet.id`).
  //
  // We sweep SQLite directly via listLanes() rather than trusting
  // packet.lane because store.reconcileOrchestratorMissionState() can
  // null packet.lane while leaving the SQLite row in a non-terminal status.
  let worktreePath: string | null = null;
  const cleanupTargets: ResetCleanupTarget[] = [];
  try {
    const { archiveLane, listLanes, updateLane } = await import('@/lib/lane/registry');
    const persisted = listLanes().filter((lane) => lane.packetId === packet.id);
    const persistedIds = new Set(persisted.map((lane) => lane.id));
    const bound = collectPacketLifecycleLanes(packet, repoPath, persisted)
      .filter((lane) => withinScope(retryScopedInput, lane.id));
    if (bound.length === 0) {
      console.log(`[reset-packet] No lane bound to packet ${packet.referenceLabel} (${packet.id})`);
    }
    // #1292 — reap live runtime procs BEFORE archiving the lane below, or a
    // killed orphan re-triggers the supervisor auto-retry into a sibling lane.
    const confirmedKills = await confirmedKilledLaneIds(bound);
    // #1292 ROOT (the real one) — archive the owned-session DIR so startup
    // discovery can't re-find the orphan and re-create a phantom lane (see
    // resetPacketViaLaneFallback above).
    await archiveResetLaneSessions(bound);
    // #1292 ROOT — unregister watched agents so they don't rehydrate + relaunch
    // into siblings on the next launch (see resetPacketViaLaneFallback above).
    for (const lane of bound) {
      if (lane.sessionKey?.trim()) unregisterWatchedAgent(lane.sessionKey.trim());
    }
    for (const lane of bound) {
      // #1215 — terminal lanes get unbound below like the rest but are never
      // re-archived and never donate a worktreePath (mirrors
      // archiveLanesForPacket, #1214).
      const terminal = lane.status === 'archived' || lane.status === 'completed';
      // First seen worktree wins for the pruning path below — matches the
      // previous single-lane behavior.
      if (!terminal && !worktreePath && lane.worktreePath) {
        worktreePath = lane.worktreePath;
      }
      if (!terminal) {
        cleanupTargets.push({
          id: lane.id,
          repoPath: lane.repoPath,
          branch: lane.branch,
          runtime: lane.runtime,
          worktreePath: lane.worktreePath,
          overrideLiveGuard: confirmedKills.has(lane.id) ? true : undefined,
        });
      }
      if (!persistedIds.has(lane.id)) continue;
      try {
        // Clear packetId first so reconciler can't re-bind this lane.
        // #1055 — wipe the worktree binding so the next dispatch cannot reuse
        // a stale path. Keep sessionKey on the archived row: archiveLane's
        // correlation contract lets realtime and reload reconciliation retire
        // the exact transcript after CLI, MCP, or UI resets.
        const updated = updateLane(lane.id, {
          packetId: '',
          worktreePath: null,
          ...(!terminal ? {
            outcome: 'discarded' as const,
            outcomeNote: 'Superseded by reset',
          } : {}),
        });
        if (!updated) throw new Error('lane disappeared during reset update');
        console.log(`[reset-packet] cleared stale lane fields for ${lane.id}`);
        if (terminal) {
          console.log(`[reset-packet] Unbound ${lane.status} lane ${lane.id} from packet ${packet.referenceLabel}`);
          continue;
        }
        const archived = archiveLane(lane.id, 'user');
        if (!archived) throw new Error('lane disappeared during reset archive');
        console.log(`[reset-packet] Archived stale lane ${lane.id} for packet ${packet.referenceLabel}`);
      } catch (error) {
        throw new ResetCleanupFailedError({
          reset: false,
          salvaged: false,
          partial: true,
          packetId: input.packetId,
          referenceLabel: packet.referenceLabel,
          worktreePruned: false,
          branchDeleted: false,
          note: `Packet ${packet.referenceLabel} worker was stopped, but lane ${lane.id} could not be retired. The packet remains held and must not be relaunched: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  } catch (error) {
    if (error instanceof ResetKillUnconfirmedError) {
      await mutateResetPacketGeneration(
        retryScopedInput,
        missionId,
        markPacketResetKillUnconfirmed,
      );
      throw error;
    }
    if (error instanceof ResetSessionArchiveUnconfirmedError) {
      await mutateResetPacketGeneration(
        retryScopedInput,
        missionId,
        markPacketResetSessionArchiveUnconfirmed,
      );
      throw error;
    }
    if (error instanceof ResetCleanupFailedError) {
      await mutateResetPacketGeneration(
        retryScopedInput,
        missionId,
        markPacketResetCleanupFailed,
      );
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await mutateResetPacketGeneration(
      retryScopedInput,
      missionId,
      markPacketResetCleanupFailed,
    );
    throw new ResetCleanupFailedError({
      reset: false,
      salvaged: false,
      partial: true,
      packetId: input.packetId,
      referenceLabel: packet.referenceLabel,
      worktreePruned: false,
      branchDeleted: false,
      note: `Packet ${packet.referenceLabel} worker retirement could not be confirmed. The packet remains held and must not be relaunched: ${detail}`,
    });
  }

  // If clearWorktree requested, prune the old worktree directory and delete
  // the packet branch so the next dispatch starts from the base branch.
  let worktreePruned = false;
  let branchDeleted = false;
  if (input.clearWorktree && packet.branchTarget && repoPath) {
    try {
      const cleanup = await cleanupResetPacketTargets(cleanupTargets, packet.id);
      worktreePruned = cleanup.worktreePruned;
      branchDeleted = cleanup.branchDeleted;
      log(`[lane-reset] Cleared packet-owned cleanup targets for packet ${packet.referenceLabel}`, cleanup);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await mutateResetPacketGeneration(
        retryScopedInput,
        missionId,
        markPacketResetCleanupFailed,
      );
      throw new ResetCleanupFailedError({
        reset: false,
        salvaged: false,
        partial: true,
        packetId: input.packetId,
        referenceLabel: packet.referenceLabel,
        worktreePruned,
        branchDeleted,
        note: `Packet ${packet.referenceLabel} worker was stopped, but worktree cleanup was not confirmed. The packet remains held and must not be relaunched: ${detail}`,
      });
    }

    // F33 fallback (#1025): cleanupIssueBranch can miss orphan worktree dirs
    // when their meta is gone and git doesn't list them against the target
    // branch (e.g. a -<suffix> dir left on `main` after a prior bad reset).
    // Sweep `<repo>/.cortex-worktrees/packet-pkt-<id>*` on disk and remove
    // anything that survived. Otherwise the next create() retry loop bumps
    // the suffix and the slow node_modules clone runs again from scratch.
    // Scoped (backgrounded-stop) resets skip the glob — it would rm -rf a
    // re-dispatched packet's live worktree (same prefix). The captured
    // cleanupTargets above already pruned this stop's own worktrees.
    if (!retryScopedInput.scope) try {
      const { readdir } = await import('node:fs/promises');
      const path = await import('node:path');
      for (const baseDir of resolveWorktreeRootLayout(repoPath).bases) {
        const dirs = await readdir(baseDir).catch(() => [] as string[]);
        const prefix = `packet-${packet.id}`;
        const orphans = dirs.filter((name) => name === prefix || name.startsWith(`${prefix}-`));
        for (const name of orphans) {
          const full = path.join(baseDir, name);
          const removed = await removeCortexWorktreePath({
            repoRoot: repoPath,
            worktreePath: full,
            logPrefix: 'lane-reset-orphan',
            operatorForce: true,
          });
          if (removed) {
            worktreePruned = true;
            log(`[lane-reset] Removed orphan worktree dir ${full} for packet ${packet.referenceLabel}`);
          }
        }
      }
    } catch (error) {
      log(
        `[lane-reset] Orphan worktree sweep failed for packet ${packet.referenceLabel}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  // #1527 — apply the hold under the lock against a FRESH read, never a
  // whole-state write from the snapshot taken at function entry. The cleanup
  // above spans seconds of async I/O; a concurrent locked write in that window
  // (headless tick, a second reset) was clobbered by the stale write — and a
  // second reset's stale snapshot still had THIS packet as 'queued', reverting
  // the hold so the next dispatch tick relaunched it ("held" that didn't hold).
  const heldPacket = await mutateResetPacketGeneration(
    retryScopedInput,
    missionId,
    markPacketResetHeld,
  );
  if (!heldPacket) {
    log(`Reset packet ${packet.referenceLabel} (${input.packetId}) — packet left mission state during cleanup; lanes cleaned, no hold to record.`);
  } else {
    log(`Reset packet ${heldPacket.referenceLabel} (${input.packetId}). Reason: ${input.reason ?? 'operator reset'}`);
  }

  if (!heldPacket || heldPacket.stateChanged) {
    const referenceLabel = heldPacket?.referenceLabel ?? packet.referenceLabel;
    return {
      reset: false,
      salvaged: false,
      packetId: input.packetId,
      referenceLabel,
      worktreePruned,
      branchDeleted,
      note: `Packet ${referenceLabel} moved to a newer generation during reset cleanup; its current state was preserved.`,
    };
  }

  return {
    reset: true,
    salvaged: false,
    packetId: input.packetId,
    referenceLabel: packet.referenceLabel,
    worktreePruned,
    branchDeleted,
    note: `Packet ${packet.referenceLabel} reset + held (will NOT auto-redispatch). Old lane archived.${worktreePruned ? ' Worktree pruned.' : ''}${branchDeleted ? ' Branch deleted.' : ''} Call dispatch_mission to re-launch.`,
  };
}

export async function resetPacket(input: ResetPacketInput) {
  return withPacketLifecycleMutationLock(input.packetId, async ({ contended }) => {
    if (contended && !input.scope) {
      return {
        reset: false,
        salvaged: false,
        packetId: input.packetId,
        referenceLabel: input.packetId,
        worktreePruned: false,
        branchDeleted: false,
        note: `Packet ${input.packetId} changed while another reset or retry was in progress; this queued lifecycle request was not applied.`,
      };
    }
    return resetPacketUnlocked(input);
  });
}
