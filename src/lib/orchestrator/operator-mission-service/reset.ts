import { cleanupIssueBranch } from './branch-cleanup';
import { currentMissionState, log } from './shared';
import type { ResetPacketInput } from './types';

export async function resetPacket(input: ResetPacketInput) {
  const state = currentMissionState();
  const packet = state.packets.find((candidate) => candidate.id === input.packetId);
  if (!packet) {
    throw new Error(`Packet ${input.packetId} not found.`);
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
  const branchCleanupExpected = input.clearWorktree && Boolean(packet.branchTarget && state.repoPath);
  try {
    const { archiveLane, listLanes, updateLane } = await import('@/lib/lane/registry');
    const bound = listLanes().filter(
      (lane) => lane.packetId === packet.id
        && lane.status !== 'archived'
        && lane.status !== 'completed',
    );
    if (bound.length === 0) {
      console.log(`[reset-packet] No active lane bound to packet ${packet.referenceLabel} (${packet.id})`);
    }
    for (const lane of bound) {
      // First seen worktree wins for the pruning path below — matches the
      // previous single-lane behavior.
      if (!worktreePath && lane.worktreePath) {
        worktreePath = lane.worktreePath;
      }
      try {
        // Clear packetId first so reconciler can't re-bind this lane.
        // #1055 — also wipe worktreePath + sessionKey so the next dispatch
        // doesn't reuse a stale path. findLaneByRepoAndBranch returns any
        // non-(archived/completed/failed) lane, so if branchCleanupExpected
        // forces us to skip archive below, the lane survives reset with its
        // old worktreePath intact — commands.ts:311 then evaluates
        // `isolate: !lane.worktreePath` to false and Codex spawns in the
        // main repo instead of a fresh worktree.
        updateLane(lane.id, { packetId: '', worktreePath: null, sessionKey: null });
        console.log(`[reset-packet] cleared stale lane fields for ${lane.id}`);
        if (branchCleanupExpected) {
          console.log(`[reset-packet] Deferred lane ${lane.id} cleanup to branch cleanup for packet ${packet.referenceLabel}`);
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
      const cleanup = await cleanupIssueBranch(state.repoPath, packet.branchTarget);
      worktreePruned = cleanup.worktreePruned;
      branchDeleted = cleanup.branchDeleted;
      log(`[lane-reset] Cleared branch ${packet.branchTarget} for packet ${packet.referenceLabel}`, cleanup);
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
    try {
      const { readdir, rm } = await import('node:fs/promises');
      const path = await import('node:path');
      const baseDir = path.join(state.repoPath, '.cortex-worktrees');
      const dirs = await readdir(baseDir).catch(() => [] as string[]);
      const prefix = `packet-${packet.id}`;
      const orphans = dirs.filter((name) => name === prefix || name.startsWith(`${prefix}-`));
      for (const name of orphans) {
        const full = path.join(baseDir, name);
        await rm(full, { recursive: true, force: true }).catch(() => {});
        worktreePruned = true;
        log(`[lane-reset] Removed orphan worktree dir ${full} for packet ${packet.referenceLabel}`);
      }
    } catch (error) {
      log(
        `[lane-reset] Orphan worktree sweep failed for packet ${packet.referenceLabel}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

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
  packet.blockedReason = null;
  packet.lane = null;
  packet.review = null;
  packet.lastEventAt = null;
  packet.lastEventLabel = null;
  // #455 — Clear recovery counter so a manual reset gives fresh retry budget
  packet.recoveryCount = 0;
  packet.lastRecoveryAt = null;

  // Persist
  const { updateOrchestratorMissionState } = await import('@/lib/orchestrator/store');
  updateOrchestratorMissionState(state);
  log(`Reset packet ${packet.referenceLabel} (${input.packetId}). Reason: ${input.reason ?? 'operator reset'}`);

  return {
    reset: true,
    packetId: input.packetId,
    referenceLabel: packet.referenceLabel,
    worktreePruned,
    branchDeleted,
    note: `Packet ${packet.referenceLabel} reset + held (will NOT auto-redispatch). Old lane archived.${worktreePruned ? ' Worktree pruned.' : ''}${branchDeleted ? ' Branch deleted.' : ''} Call dispatch_mission to re-launch.`,
  };
}
