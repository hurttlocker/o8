import { runDispatchTick } from '@/lib/orchestrator/dispatch';
import { archiveLane, listLanes, updateLane } from '@/lib/lane/registry';
import {
  archiveLaneSessionsConfirmed,
  killLaneSessionsConfirmed,
  LaneSessionArchiveUnconfirmedError,
} from '@/lib/lane/reap-sessions';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { frontierEscalationModelForCheapTier } from '@/lib/operator/subscription-profile';
import { supersedeDurableApprovedReviews } from '@/lib/lane/durable-review-approval';
import { log } from './shared';
import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import {
  holdPacketLifecycleMutation,
  markPacketLifecycleFailure,
  mutatePacketLifecycleGuard,
  type PacketLifecycleGuard,
} from '@/lib/orchestrator/packet-lifecycle-guard';
import { collectPacketLifecycleLanes } from '@/lib/orchestrator/packet-lifecycle-targets';
import { cleanupResetPacketTargets, type ResetCleanupTarget } from './reset-cleanup';
import { unregisterWatchedAgent } from '@/lib/supervisor/agent-supervisor';

/**
 * #662 — One-click rerun-with-feedback.
 *
 * Used after the operator rejects a diff. The packet is generation-held while
 * its prior worker is retired, then reset and dispatched in one locked write:
 *   1. Archives the rejected lane (preserves its diff in lane history),
 *      prunes the worktree.
 *   2. Resets the packet to dispatchable state.
 *   3. Appends the operator's feedback to the packet summary (which is what
 *      `buildPacketPrompt` actually feeds the agent) and the prompt
 *      (surfaced in the details popover).
 *   4. Runs a dispatch tick so the packet relaunches in a fresh worktree.
 *
 * The lifecycle hold prevents a headless or explicit dispatch from binding a
 * replacement while the prior worker, session, and worktree still exist.
 */
export interface RerunWithFeedbackInput {
  packetId: string;
  feedback: string;
}

export interface RerunEscalationSuggestion {
  targetRuntime: 'claude-code';
  targetModel: string;
  reason: string;
}

export interface RerunWithFeedbackResult {
  packetId: string;
  referenceLabel: string;
  dispatched: boolean;
  worktreePruned: boolean;
  /** Present when a single-sub cheap-tier packet crossed the rerun threshold (P3 ladder). */
  escalationSuggestion?: RerunEscalationSuggestion;
  note: string;
}

export class RerunKillUnconfirmedError extends Error {}
export class RerunSessionArchiveUnconfirmedError extends Error {}
export class RerunCleanupFailedError extends Error {}
export class RerunPostRetirementFailedError extends Error {}
export class RerunStateChangedError extends Error {}

const FEEDBACK_HEADING = '## Operator feedback';
// Match an existing feedback section (preceded by 1+ blank lines) and
// everything after it, so repeat reruns replace the prior feedback rather
// than stacking.
const FEEDBACK_SECTION_RX = new RegExp(`\\n+${FEEDBACK_HEADING}[\\s\\S]*$`);

function appendFeedback(base: string, feedback: string) {
  const trimmed = base.trim();
  const stripped = trimmed.replace(FEEDBACK_SECTION_RX, '').trim();
  const trimmedFeedback = feedback.trim();
  if (!stripped) return `${FEEDBACK_HEADING}\n${trimmedFeedback}`;
  return `${stripped}\n\n${FEEDBACK_HEADING}\n${trimmedFeedback}`;
}

function buildEscalationSuggestion(packet: OrchestratorPacket, nextAttemptCount: number): RerunEscalationSuggestion | null {
  if (nextAttemptCount < 2 || packet.tierEscalated === true) return null;
  const targetModel = frontierEscalationModelForCheapTier({
    profile: getOperatorDefaultsSync().values.subscriptionProfile,
    runtime: packet.workerRouting?.selectedRuntime ?? packet.runtime,
    model: packet.workerRouting?.selectedModel ?? packet.assignedModel ?? null,
  });
  if (!targetModel) return null;
  return {
    targetRuntime: 'claude-code' as const,
    targetModel,
    reason: `This single-subscription cheap-tier packet has been rerun ${nextAttemptCount} times. Consider rerunning the next attempt on ${targetModel}; o8 will not escalate automatically.`,
  };
}

/**
 * Mirrors the resetPacket lane-archival path. Returns the first worktree
 * path encountered so the caller can prune it.
 *
 * Exported for the lane-rebind vitest suite (#1214) — not part of the public API.
 */
export function archiveLanesForPacket(packetId: string, referenceLabel: string): string | null {
  let worktreePath: string | null = null;
  try {
    const bound = listLanes().filter((lane) => lane.packetId === packetId);
    for (const lane of bound) {
      // #1214 — terminal lanes must be UNBOUND too (not just skipped). A dead
      // archived lane that keeps its packetId poisons every packet-keyed read
      // after recovery: the reconciler derives packet status 'archived' from
      // it (blocking redispatch), findLatestLaneByPacket resolves governance
      // reads to it, and the already-released merge check sees a terminal
      // lane and short-circuits the recovery lane's merge as "Already
      // released". The new lane created by the dispatch below is the sole
      // binding going forward.
      const terminal = lane.status === 'archived' || lane.status === 'completed';
      if (!terminal && !worktreePath && lane.worktreePath) {
        worktreePath = lane.worktreePath;
      }
      try {
        if (!terminal) {
          updateLane(lane.id, {
            outcome: 'discarded',
            outcomeNote: 'Superseded by rerun',
          });
        }
        // Clear packetId first so reconciler can't re-bind this lane.
        updateLane(lane.id, { packetId: '' });
        if (terminal) {
          console.log(`[rerun-with-feedback] Unbound ${lane.status} lane ${lane.id} from packet ${referenceLabel}`);
          continue;
        }
        archiveLane(lane.id, 'user');
        console.log(`[rerun-with-feedback] Archived stale lane ${lane.id} for packet ${referenceLabel}`);
      } catch (error) {
        console.warn(
          `[rerun-with-feedback] Could not archive lane ${lane.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    console.warn(
      `[rerun-with-feedback] Lane registry lookup failed for packet ${referenceLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return worktreePath;
}

/** Exported for the retry-budget vitest suite — not part of the public API. */
export function resetPacketFields(packet: OrchestratorPacket) {
  // Mirrors resetPacket's mission-state mutations. Intentional duplication
  // so the reset is part of our locked write rather than a non-atomic
  // in-memory broadcast.
  packet.status = 'draft';
  packet.queueState = 'queued';
  packet.releaseState = 'pending';
  packet.releaseStatePayload = null;
  packet.archivedAt = null;
  packet.blockedReason = null;
  packet.recovery = null;
  packet.lane = null;
  packet.review = null;
  packet.lastEventAt = null;
  packet.lastEventLabel = null;
  packet.operatorStopped = false;
  packet.recoveryCount = 0;
  packet.lastRecoveryAt = null;
  // A fresh dispatch earns a fresh launch budget; the intra-cycle cap still
  // stops the launching<->idle thrash within this new attempt.
  packet.launchAttempts = 0;
  // Deliberately NOT reset: packet.typecheckAutoRetries. The auto-rerun
  // budget (#1108 layer 1) must survive redispatch — zeroing it here would
  // let a persistently type-broken packet loop full workers forever. Only
  // operator reset_packet refreshes it.
}

async function retireRerunGeneration(guard: PacketLifecycleGuard): Promise<boolean> {
  const persisted = listLanes().filter((lane) => lane.packetId === guard.packetId);
  const targets = collectPacketLifecycleLanes(guard.previousPacket, guard.repoPath, persisted);
  const kills = await killLaneSessionsConfirmed(targets);
  const survivors = kills.filter((outcome) => !outcome.confirmed && !outcome.alreadyDead);
  if (survivors.length > 0) {
    await markPacketLifecycleFailure(guard, 'kill_unconfirmed');
    throw new RerunKillUnconfirmedError(
      `Rerun refused because ${survivors.length} worker process${survivors.length === 1 ? '' : 'es'} could not be confirmed stopped. The packet remains held and its bindings were preserved.`,
    );
  }
  try {
    await archiveLaneSessionsConfirmed(targets);
  } catch (error) {
    if (!(error instanceof LaneSessionArchiveUnconfirmedError)) throw error;
    await markPacketLifecycleFailure(guard, 'session_archive_unconfirmed');
    throw new RerunSessionArchiveUnconfirmedError(error.message);
  }

  for (const target of targets) {
    if (target.sessionKey?.trim()) unregisterWatchedAgent(target.sessionKey.trim());
  }
  const confirmedKills = new Set(kills
    .filter((outcome) => outcome.confirmed || outcome.alreadyDead)
    .map((outcome) => `${outcome.laneId}\0${outcome.sessionKey}`));
  const cleanupTargets: ResetCleanupTarget[] = targets
    .filter((target) => target.status !== 'archived' && target.status !== 'completed')
    .map((target) => ({
      id: target.id,
      repoPath: target.repoPath,
      branch: target.branch,
      worktreePath: target.worktreePath,
      overrideLiveGuard: target.sessionKey?.trim()
        && confirmedKills.has(`${target.id}\0${target.sessionKey}`)
        ? true
        : undefined,
    }));
  let worktreePruned = false;
  try {
    const cleanup = await cleanupResetPacketTargets(cleanupTargets, guard.packetId);
    worktreePruned = cleanup.worktreePruned;
  } catch (error) {
    await markPacketLifecycleFailure(guard, 'worktree_cleanup_failed');
    throw new RerunCleanupFailedError(
      `Rerun stopped the prior worker, but worktree cleanup was not confirmed. The packet remains held and was not relaunched: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const lane of persisted) {
    const terminal = lane.status === 'archived' || lane.status === 'completed';
    try {
      const updated = updateLane(lane.id, {
        packetId: '',
        worktreePath: null,
        ...(!terminal ? {
          outcome: 'discarded' as const,
          outcomeNote: 'Superseded by rerun',
        } : {}),
      });
      if (!updated) throw new Error('lane disappeared during rerun update');
      if (!terminal) {
        const archived = archiveLane(lane.id, 'user');
        if (!archived) throw new Error('lane disappeared during rerun archive');
      }
    } catch (error) {
      await markPacketLifecycleFailure(guard, 'worktree_cleanup_failed');
      throw new RerunCleanupFailedError(
        `Rerun could not retire lane ${lane.id}; the packet remains held and was not relaunched: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return worktreePruned;
}

async function retireFailedRerunReplacement(guard: PacketLifecycleGuard): Promise<{
  confirmed: boolean;
  lane: ReturnType<typeof listLanes>[number] | null;
}> {
  const replacements = listLanes().filter((lane) => lane.packetId === guard.packetId);
  const latest = replacements.at(-1) ?? null;
  if (replacements.length === 0) return { confirmed: true, lane: null };
  try {
    const kills = await killLaneSessionsConfirmed(replacements);
    if (kills.some((outcome) => !outcome.confirmed && !outcome.alreadyDead)) {
      return { confirmed: false, lane: latest };
    }
    await archiveLaneSessionsConfirmed(replacements);
    for (const lane of replacements) {
      if (lane.sessionKey?.trim()) unregisterWatchedAgent(lane.sessionKey.trim());
    }
    const confirmed = new Set(kills
      .filter((outcome) => outcome.confirmed || outcome.alreadyDead)
      .map((outcome) => `${outcome.laneId}\0${outcome.sessionKey}`));
    await cleanupResetPacketTargets(replacements.map((lane) => ({
      id: lane.id,
      repoPath: lane.repoPath,
      branch: lane.branch,
      worktreePath: lane.worktreePath,
      overrideLiveGuard: lane.sessionKey?.trim()
        && confirmed.has(`${lane.id}\0${lane.sessionKey}`)
        ? true
        : undefined,
    })), guard.packetId);
    for (const lane of replacements) {
      const updated = updateLane(lane.id, {
        packetId: '',
        worktreePath: null,
        outcome: 'discarded',
        outcomeNote: 'Failed rerun replacement retired',
      });
      if (!updated) return { confirmed: false, lane };
      const archived = archiveLane(lane.id, 'user');
      if (!archived) return { confirmed: false, lane };
    }
    return { confirmed: true, lane: null };
  } catch {
    return { confirmed: false, lane: latest };
  }
}

async function markFailedRerunReplacement(
  guard: PacketLifecycleGuard,
  lane: ReturnType<typeof listLanes>[number],
): Promise<void> {
  await mutatePacketLifecycleGuard(guard, (packet) => {
    packet.status = 'blocked';
    packet.queueState = 'held';
    packet.operatorStopped = true;
    packet.blockedReason = 'rerun_replacement_retirement_failed';
    packet.lastEventAt = new Date().toISOString();
    packet.lastEventLabel = 'rerun_replacement_retirement_failed';
    packet.lane = {
      tileId: packet.lane?.tileId ?? 'mcp-dispatch',
      tabId: packet.lane?.tabId ?? 'mcp-dispatch',
      repoPath: lane.repoPath,
      worktreePath: lane.worktreePath,
      runtime: lane.runtime,
      laneId: lane.id,
      sessionKey: lane.sessionKey,
      lastHeartbeatAt: lane.lastHeartbeatAt ? new Date(lane.lastHeartbeatAt).toISOString() : null,
      lastEventAt: lane.lastEventAt,
      lastEventLabel: lane.lastEventLabel,
    };
  });
}

async function rerunWithFeedbackUnlocked(input: RerunWithFeedbackInput): Promise<RerunWithFeedbackResult> {
  const packetId = input.packetId.trim();
  if (!packetId) {
    throw new Error('packetId is required.');
  }
  const feedback = input.feedback.trim();
  if (!feedback) {
    throw new Error('feedback is required.');
  }

  const guard = await holdPacketLifecycleMutation({ packetId, kind: 'rerun' });
  if (!guard) throw new Error(`Packet ${packetId} not found.`);
  const worktreePruned = await retireRerunGeneration(guard);
  const originalSummary = guard.previousPacket.summary;
  const originalPrompt = guard.previousPacket.prompt?.trim()
    || [guard.previousPacket.title, originalSummary].map((part) => part.trim()).filter(Boolean).join('\n\n');
  let escalationSuggestion: RerunEscalationSuggestion | null = null;
  let relaunched: Awaited<ReturnType<typeof mutatePacketLifecycleGuard<boolean>>>;
  try {
    await supersedeDurableApprovedReviews(packetId, 'Superseded by rerun_with_feedback.');
    relaunched = await mutatePacketLifecycleGuard(guard, async (packet, current) => {
      resetPacketFields(packet);
      const nextAttemptCount = (packet.attemptCount ?? 0) + 1;
      escalationSuggestion = buildEscalationSuggestion(packet, nextAttemptCount);
      packet.attemptCount = nextAttemptCount;
      if (escalationSuggestion) packet.tierEscalated = true;
      packet.summary = appendFeedback(originalSummary, feedback);
      packet.prompt = appendFeedback(originalPrompt, feedback);
      const afterDispatch = await runDispatchTick(current);
      Object.assign(current, afterDispatch);
      const dispatchedPacket = current.packets.find((candidate) => candidate.id === packetId) ?? null;
      return Boolean(dispatchedPacket?.lane?.laneId || dispatchedPacket?.lane?.sessionKey);
    });
  } catch (error) {
    const replacement = await retireFailedRerunReplacement(guard);
    if (replacement.confirmed) {
      await markPacketLifecycleFailure(guard, 'rerun_failed');
    } else if (replacement.lane) {
      await markFailedRerunReplacement(guard, replacement.lane);
    }
    throw new RerunPostRetirementFailedError(
      replacement.confirmed
        ? `The prior rerun generation was retired, but its replacement could not be prepared. The packet remains held with no replacement worker: ${error instanceof Error ? error.message : String(error)}`
        : `The rerun replacement failed after launch and could not be confirmed retired. Its lane remains bound and the packet is held for manual recovery: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!relaunched.matched) {
    throw new RerunStateChangedError(
      `Packet ${packetId} changed before rerun could relaunch it. The retired generation was not replaced by another worker.`,
    );
  }
  const dispatched = relaunched.result === true;
  const referenceLabel = guard.previousPacket.referenceLabel;

  log(`Rerun-with-feedback for packet ${referenceLabel} (${packetId}). dispatched=${dispatched}`);

  return {
    packetId,
    referenceLabel,
    dispatched,
    worktreePruned,
    escalationSuggestion: escalationSuggestion ?? undefined,
    note: dispatched
      ? `Packet ${referenceLabel} relaunched with operator feedback.`
      : `Packet ${referenceLabel} reset and queued. Awaiting next dispatch tick.`,
  };
}

export function rerunWithFeedback(input: RerunWithFeedbackInput): Promise<RerunWithFeedbackResult> {
  return withPacketLifecycleMutationLock(input.packetId, async ({ contended }) => {
    if (contended) {
      throw new RerunStateChangedError(
        `Packet ${input.packetId} changed while another lifecycle action was in progress; rerun was not applied.`,
      );
    }
    return rerunWithFeedbackUnlocked(input);
  });
}
