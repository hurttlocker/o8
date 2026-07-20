import { cleanupResetPacketTargets, type ResetCleanupTarget } from './reset-cleanup';
import { currentMissionState, log } from './shared';
import type { ResetPacketInput } from './types';
import { archiveLaneSessions, killLaneSessionsConfirmed } from '@/lib/lane/reap-sessions';
import { removeCortexWorktreePath } from '@/lib/lane/worktree-clone-removal';
import { unregisterWatchedAgent } from '@/lib/supervisor/agent-supervisor';
import { findMissionRegistryEntryByPacketId, withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { resolveWorktreeRootLayout } from '@/lib/worktree/root-layout';
import { supersedeDurableApprovedReviews } from '@/lib/lane/durable-review-approval';

function withinScope(input: ResetPacketInput, laneId: string): boolean {
  return !input.scope || input.scope.laneIds.includes(laneId);
}

async function confirmedKilledLaneIds(lanes: Parameters<typeof killLaneSessionsConfirmed>[0]) {
  const outcomes = await killLaneSessionsConfirmed(lanes);
  return new Set(
    outcomes
      .filter((outcome) => outcome.confirmed || outcome.alreadyDead)
      .map((outcome) => outcome.laneId),
  );
}

async function resetPacketViaLaneFallback(input: ResetPacketInput) {
  const { archiveLane, listLanes, updateLane } = await import('@/lib/lane/registry');
  const allBound = listLanes().filter((lane) => lane.packetId === input.packetId && withinScope(input, lane.id));

  if (allBound.length === 0) {
    throw new Error(`Packet ${input.packetId} not found — no mission packet and no lane.`);
  }
  await supersedeDurableApprovedReviews(input.packetId, 'Superseded by reset_packet.');

  // #1215 — same sweep as archiveLanesForPacket (#1214): terminal lanes must
  // be UNBOUND, not skipped, or a dead archived lane keeps its packetId
  // through the reset and poisons every packet-keyed read afterwards. Only
  // active lanes go through the archive + branch-cleanup path below.
  const bound: typeof allBound = [];
  for (const lane of allBound) {
    if (lane.status !== 'archived' && lane.status !== 'completed') {
      bound.push(lane);
      continue;
    }
    try {
      updateLane(lane.id, { packetId: '', worktreePath: null, sessionKey: null });
      console.log(`[reset-packet] Unbound ${lane.status} lane ${lane.id} from evicted packet ${input.packetId}`);
    } catch (error) {
      console.warn(
        `[reset-packet] Could not unbind terminal lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // #1292 — reap the live runtime procs BEFORE we null their sessionKeys. A
  // reset that leaves the codex exec running lets it later exit/fail and the
  // agent-supervisor relaunches it into a SIBLING lane (the zombie-multiply).
  // The confirmed-kill ladder verifies exit before any live-guard override is granted.
  const confirmedKills = await confirmedKilledLaneIds(bound);
  // #1292 ROOT (the real one) — archive the owned-session DIR (move to
  // -archive) so startup discovery (computeFleetAdditions, no retirement gate)
  // can't re-find the orphan and re-create a phantom lane. Reset previously left
  // the dir in the ACTIVE tree, so one dispatch's leftover dirs re-spawned a lane
  // on every restart. Runs after the interrupt (proc stopped), before sessionKey
  // is nulled below. Transcript stays reviewable via the archive-aware tail.
  await archiveLaneSessions(bound);
  // #1292 ROOT — unregister each reset lane's watched agent so its orphaned
  // watched_agents row can't survive into the next app launch, get rehydrated,
  // and re-trigger the supervisor's relaunch into a fresh sibling lane+session
  // (the dominant multiply: ~154 sessions for ~7 tasks). Registration is
  // explicit (dispatch → /supervisor/watch), so this delete sticks — nothing
  // auto-rediscovers and re-adds it.
  for (const lane of bound) {
    if (lane.sessionKey?.trim()) unregisterWatchedAgent(lane.sessionKey.trim());
  }

  const cleanupTargets: ResetCleanupTarget[] = [];
  let firstWorktreePath: string | null = null;
  for (const lane of bound) {
    if (!firstWorktreePath && lane.worktreePath) {
      firstWorktreePath = lane.worktreePath;
    }
    cleanupTargets.push({
      id: lane.id,
      repoPath: lane.repoPath,
      branch: lane.branch,
      worktreePath: lane.worktreePath,
      overrideLiveGuard: confirmedKills.has(lane.id) ? true : undefined,
    });
    try {
      updateLane(lane.id, {
        packetId: '',
        worktreePath: null,
        sessionKey: null,
        outcome: 'discarded',
        outcomeNote: 'Superseded by reset',
      });
      console.log(`[reset-packet] cleared stale lane fields for ${lane.id}`);
      archiveLane(lane.id, 'user');
      console.log(`[reset-packet] Archived stale lane ${lane.id} for evicted packet ${input.packetId}`);
    } catch (error) {
      console.warn(
        `[reset-packet] Could not archive lane ${lane.id} — may already be gone: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let worktreePruned = false;
  let branchDeleted = false;
  if (input.clearWorktree) {
    try {
      const cleanup = await cleanupResetPacketTargets(cleanupTargets, input.packetId);
      worktreePruned = worktreePruned || cleanup.worktreePruned;
      branchDeleted = branchDeleted || cleanup.branchDeleted;
      log(`[lane-reset] Cleared packet-owned cleanup targets for evicted packet ${input.packetId}`, cleanup);
    } catch (error) {
      log(
        `[lane-reset] Could not clear packet-owned cleanup targets${firstWorktreePath ? ` at ${firstWorktreePath}` : ''} — may already be gone`,
        error instanceof Error ? error.message : String(error),
      );
    }

    // F33 fallback (#1025): mirror the in-mission reset sweep for packets
    // missing from current mission state but still backed by durable lanes.
    // Scoped (backgrounded-stop) resets skip the prefix glob entirely — a
    // re-dispatch during the cleanup window creates a dir matching the same
    // packet prefix, and the glob would rm -rf the LIVE worker's checkout.
    // The captured cleanupTargets above already pruned this stop's worktrees.
    if (!input.scope) try {
      const { readdir } = await import('node:fs/promises');
      const path = await import('node:path');
      // #1215 — derive repos from ALL bound lanes (terminal included) so a
      // packet stranded on only-terminal lanes still gets its worktree dirs
      // swept.
      const repoPaths = new Set(allBound.map((lane) => lane.repoPath));
      for (const repoPath of repoPaths) {
        for (const baseDir of resolveWorktreeRootLayout(repoPath).bases) {
          const dirs = await readdir(baseDir).catch(() => [] as string[]);
          const prefix = `packet-${input.packetId}`;
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
              log(`[lane-reset] Removed orphan worktree dir ${full} for evicted packet ${input.packetId}`);
            }
          }
        }
      }
    } catch (error) {
      log(
        `[lane-reset] Orphan worktree sweep failed for evicted packet ${input.packetId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return {
    reset: true,
    packetId: input.packetId,
    referenceLabel: input.packetId,
    worktreePruned,
    branchDeleted,
    note: `Packet ${input.packetId} reset via lane fallback — packet was not in mission state. Old lane archived.${worktreePruned ? ' Worktree pruned.' : ''}${branchDeleted ? ' Branch deleted.' : ''} Call dispatch_mission to re-launch.`,
  };
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
  // Same for the self-review stall budget + the operator-Stop flag (2026-06-22):
  // a reset gives a fresh stall budget and re-enables dispatch.
  packet.stallRetries = 0;
  packet.launchAttempts = 0;
  packet.operatorStopped = false;
  packet.tierEscalated = undefined;
}

async function resetRegistryPacket(input: ResetPacketInput, missionId: string) {
  if (!input.scope?.skipHoldIfStateMoved) {
    await withMissionRegistryState(missionId, (state) => {
      const packet = state.packets.find((candidate) => candidate.id === input.packetId);
      if (!packet) throw new Error(`Packet ${input.packetId} not found.`);
      markPacketResetHeld(packet);
      return { state, result: undefined };
    });
  }
  await supersedeDurableApprovedReviews(input.packetId, 'Superseded by reset_packet.');
  let worktreePruned = false;
  let branchDeleted = false;
  try {
    const laneReset = await resetPacketViaLaneFallback(input);
    worktreePruned = laneReset.worktreePruned;
    branchDeleted = laneReset.branchDeleted;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('no mission packet and no lane')) {
      throw error;
    }
  }

  const { result } = await withMissionRegistryState(missionId, (state) => {
    const packet = state.packets.find((candidate) => candidate.id === input.packetId);
    if (!packet) {
      throw new Error(`Packet ${input.packetId} not found.`);
    }
    markPacketResetHeld(packet);
    log(`Reset registry packet ${packet.referenceLabel} (${input.packetId}). Reason: ${input.reason ?? 'operator reset'}`);
    return {
      state,
      result: {
        reset: true,
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

export async function resetPacket(input: ResetPacketInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    const registryEntry = findMissionRegistryEntryByPacketId(input.packetId, {
      includeArchived: true,
      excludeMissionId: state.missionId,
    });
    if (registryEntry) {
      return resetRegistryPacket(input, registryEntry.id);
    }
    return resetPacketViaLaneFallback(input);
  }
  await supersedeDurableApprovedReviews(input.packetId, 'Superseded by reset_packet.');

  // Hold first, before session teardown and worktree cleanup open an async
  // window. Otherwise the headless dispatcher can relaunch this packet while
  // reset is still working, despite the final response promising a hold.
  if (!input.scope?.skipHoldIfStateMoved) {
    const { withLockedState } = await import('@/lib/orchestrator/control-plane');
    await withLockedState((fresh) => {
      const target = fresh.packets.find((candidate) => candidate.id === input.packetId);
      if (target) markPacketResetHeld(target);
    });
  }

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
    const bound = listLanes().filter((lane) => lane.packetId === packet.id && withinScope(input, lane.id));
    if (bound.length === 0) {
      console.log(`[reset-packet] No lane bound to packet ${packet.referenceLabel} (${packet.id})`);
    }
    // #1292 — reap live runtime procs BEFORE nulling sessionKey below, or a
    // killed orphan re-triggers the supervisor auto-retry into a sibling lane.
    const confirmedKills = await confirmedKilledLaneIds(bound);
    // #1292 ROOT (the real one) — archive the owned-session DIR so startup
    // discovery can't re-find the orphan and re-create a phantom lane (see
    // resetPacketViaLaneFallback above).
    await archiveLaneSessions(bound);
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
          worktreePath: lane.worktreePath,
          overrideLiveGuard: confirmedKills.has(lane.id) ? true : undefined,
        });
      }
      try {
        // Clear packetId first so reconciler can't re-bind this lane.
        // #1055 — also wipe worktreePath + sessionKey so the next dispatch
        // doesn't reuse a stale path. The clearWorktree branch cleanup below
        // uses the captured lane snapshot, so the archived row can be scrubbed
        // here without losing the target worktree path.
        updateLane(lane.id, {
          packetId: '',
          worktreePath: null,
          sessionKey: null,
          ...(!terminal ? {
            outcome: 'discarded' as const,
            outcomeNote: 'Superseded by reset',
          } : {}),
        });
        console.log(`[reset-packet] cleared stale lane fields for ${lane.id}`);
        if (terminal) {
          console.log(`[reset-packet] Unbound ${lane.status} lane ${lane.id} from packet ${packet.referenceLabel}`);
          continue;
        }
        archiveLane(lane.id, 'user');
        console.log(`[reset-packet] Archived stale lane ${lane.id} for packet ${packet.referenceLabel}`);
      } catch (error) {
        console.warn(
          `[reset-packet] Could not archive lane ${lane.id} — may already be gone: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[reset-packet] Lane registry lookup failed for packet ${packet.referenceLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // If clearWorktree requested, prune the old worktree directory and delete
  // the packet branch so the next dispatch starts from the base branch.
  let worktreePruned = false;
  let branchDeleted = false;
  if (input.clearWorktree && packet.branchTarget && state.repoPath) {
    try {
      const cleanup = await cleanupResetPacketTargets(cleanupTargets, packet.id);
      worktreePruned = cleanup.worktreePruned;
      branchDeleted = cleanup.branchDeleted;
      log(`[lane-reset] Cleared packet-owned cleanup targets for packet ${packet.referenceLabel}`, cleanup);
    } catch (error) {
      log(
        `[lane-reset] Could not clear branch ${packet.branchTarget}${worktreePath ? ` at ${worktreePath}` : ''} — may already be gone`,
        error instanceof Error ? error.message : String(error),
      );
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
    if (!input.scope) try {
      const { readdir } = await import('node:fs/promises');
      const path = await import('node:path');
      for (const baseDir of resolveWorktreeRootLayout(state.repoPath).bases) {
        const dirs = await readdir(baseDir).catch(() => [] as string[]);
        const prefix = `packet-${packet.id}`;
        const orphans = dirs.filter((name) => name === prefix || name.startsWith(`${prefix}-`));
        for (const name of orphans) {
          const full = path.join(baseDir, name);
          const removed = await removeCortexWorktreePath({
            repoRoot: state.repoPath,
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
  const { withLockedState } = await import('@/lib/orchestrator/control-plane');
  const { result: heldPacket } = await withLockedState((fresh) => {
    const target = fresh.packets.find((candidate) => candidate.id === input.packetId);
    if (!target) return null;
    // Generation guard for backgrounded cleanup: if the packet has moved on
    // from the operator-stopped hold this cleanup belongs to (a legitimate
    // re-dispatch cleared it / bound a new lane), the stale cleanup must NOT
    // stomp the live state back to draft/held.
    if (input.scope?.skipHoldIfStateMoved && (!target.operatorStopped || target.lane)) {
      log(`Reset packet ${target.referenceLabel} (${input.packetId}) — state moved on during background cleanup; hold skipped.`);
      return { referenceLabel: target.referenceLabel };
    }
    markPacketResetHeld(target);
    return { referenceLabel: target.referenceLabel };
  });
  if (!heldPacket) {
    log(`Reset packet ${packet.referenceLabel} (${input.packetId}) — packet left mission state during cleanup; lanes cleaned, no hold to record.`);
  } else {
    log(`Reset packet ${heldPacket.referenceLabel} (${input.packetId}). Reason: ${input.reason ?? 'operator reset'}`);
  }

  return {
    reset: true,
    packetId: input.packetId,
    referenceLabel: packet.referenceLabel,
    worktreePruned,
    branchDeleted,
    note: `Packet ${packet.referenceLabel} reset + held (will NOT auto-redispatch). Old lane archived.${worktreePruned ? ' Worktree pruned.' : ''}${branchDeleted ? ' Branch deleted.' : ''} Call dispatch_mission to re-launch.`,
  };
}
