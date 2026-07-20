import { withLockedState } from '@/lib/orchestrator/control-plane';
import { runDispatchTick } from '@/lib/orchestrator/dispatch';
import { archiveLane, listLanes, updateLane } from '@/lib/lane/registry';
import { getWorktreeManager } from '@/lib/worktree/launch';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import { findMissionRegistryEntryByPacketId, withMissionRegistryState } from '@/lib/orchestrator/mission-registry';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import { frontierEscalationModelForCheapTier } from '@/lib/operator/subscription-profile';
import { currentMissionState, log } from './shared';

/**
 * #662 — One-click rerun-with-feedback.
 *
 * Used after the operator rejects a diff. Within a single locked write:
 *   1. Archives the rejected lane (preserves its diff in lane history),
 *      prunes the worktree.
 *   2. Resets the packet to dispatchable state.
 *   3. Appends the operator's feedback to the packet summary (which is what
 *      `buildPacketPrompt` actually feeds the agent) and the prompt
 *      (surfaced in the details popover).
 *   4. Runs a dispatch tick so the packet relaunches in a fresh worktree.
 *
 * Doing the reset + dispatch inside one `withLockedState` block keeps
 * the operation atomic — no headless-tick can race in between and read
 * a partially-mutated mission.
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

async function pruneWorktree(repoPath: string | null | undefined, worktreePath: string): Promise<boolean> {
  if (!repoPath) return false;
  try {
    const manager = await getWorktreeManager(repoPath);
    const worktrees = await manager.list();
    const match = worktrees.find((wt) => worktreePath.includes(wt.id));
    if (!match) return false;
    await manager.cleanup(match.id, { force: true, deleteBranch: true });
    log(`[rerun-with-feedback] Pruned worktree ${match.id}`);
    return true;
  } catch {
    log(`[rerun-with-feedback] Could not prune worktree at ${worktreePath} — may already be gone`);
    return false;
  }
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

async function rerunRegistryPacketWithFeedback(
  missionId: string,
  packetId: string,
  feedback: string,
): Promise<RerunWithFeedbackResult> {
  let worktreePruned = false;
  let referenceLabel = packetId;
  let escalationSuggestion: RerunEscalationSuggestion | null = null;

  const { state: finalState } = await withMissionRegistryState(missionId, async (current) => {
    const packet = current.packets.find((candidate) => candidate.id === packetId);
    if (!packet) {
      throw new Error(`Packet ${packetId} not found.`);
    }
    referenceLabel = packet.referenceLabel;

    const originalSummary = packet.summary;
    const originalPrompt = packet.prompt?.trim()
      || [packet.title, originalSummary].map((part) => part.trim()).filter(Boolean).join('\n\n');

    const worktreePath = archiveLanesForPacket(packetId, packet.referenceLabel);
    if (worktreePath) {
      worktreePruned = await pruneWorktree(current.repoPath, worktreePath);
    }

    resetPacketFields(packet);
    const nextAttemptCount = (packet.attemptCount ?? 0) + 1;
    escalationSuggestion = buildEscalationSuggestion(packet, nextAttemptCount);
    packet.attemptCount = nextAttemptCount;
    if (escalationSuggestion) packet.tierEscalated = true;
    packet.summary = appendFeedback(originalSummary, feedback);
    packet.prompt = appendFeedback(originalPrompt, feedback);

    const afterDispatch = await runDispatchTick(current);
    return { state: afterDispatch, result: null };
  });

  const dispatchedPacket = finalState.packets.find((candidate) => candidate.id === packetId) ?? null;
  const dispatched = Boolean(dispatchedPacket?.lane?.laneId || dispatchedPacket?.lane?.sessionKey);

  log(`Rerun-with-feedback for registry packet ${referenceLabel} (${packetId}). dispatched=${dispatched}`);

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

export async function rerunWithFeedback(input: RerunWithFeedbackInput): Promise<RerunWithFeedbackResult> {
  const packetId = input.packetId.trim();
  if (!packetId) {
    throw new Error('packetId is required.');
  }
  const feedback = input.feedback.trim();
  if (!feedback) {
    throw new Error('feedback is required.');
  }

  const current = currentMissionState();
  if (!current.packets.some((candidate) => candidate.id === packetId)) {
    const registryEntry = findMissionRegistryEntryByPacketId(packetId, {
      includeArchived: true,
      excludeMissionId: current.missionId,
    });
    if (!registryEntry) {
      throw new Error(`Packet ${packetId} not found.`);
    }
    return rerunRegistryPacketWithFeedback(registryEntry.id, packetId, feedback);
  }

  let worktreePruned = false;
  let referenceLabel = packetId;
  let escalationSuggestion: RerunEscalationSuggestion | null = null;

  const { state: finalState } = await withLockedState(async (current) => {
    const packet = current.packets.find((candidate) => candidate.id === packetId);
    if (!packet) {
      throw new Error(`Packet ${packetId} not found.`);
    }
    referenceLabel = packet.referenceLabel;

    // Snapshot originals BEFORE reset clears them.
    const originalSummary = packet.summary;
    const originalPrompt = packet.prompt?.trim()
      || [packet.title, originalSummary].map((part) => part.trim()).filter(Boolean).join('\n\n');

    // Step 1 — archive the rejected lane (preserves its diff in lane
    // history) and prune the worktree so the redispatch starts clean.
    const worktreePath = archiveLanesForPacket(packetId, packet.referenceLabel);
    if (worktreePath) {
      worktreePruned = await pruneWorktree(current.repoPath, worktreePath);
    }

    // Step 2 — reset packet fields so the dispatch tick treats it as queued.
    resetPacketFields(packet);
    const nextAttemptCount = (packet.attemptCount ?? 0) + 1;
    escalationSuggestion = buildEscalationSuggestion(packet, nextAttemptCount);
    packet.attemptCount = nextAttemptCount;
    if (escalationSuggestion) packet.tierEscalated = true;

    // Step 3 — apply feedback to summary (consumed by buildPacketPrompt)
    // and prompt (surfaced in the details popover).
    packet.summary = appendFeedback(originalSummary, feedback);
    packet.prompt = appendFeedback(originalPrompt, feedback);

    // Step 4 — run a dispatch tick so the packet relaunches with the
    // updated prompt. Copy the post-dispatch snapshot back onto the locked
    // `current` object so withLockedState reconciles and writes the launch
    // result instead of the pre-dispatch snapshot.
    const afterDispatch = await runDispatchTick(current);
    Object.assign(current, afterDispatch);
  });

  const dispatchedPacket = finalState.packets.find((candidate) => candidate.id === packetId) ?? null;
  const dispatched = Boolean(dispatchedPacket?.lane?.laneId || dispatchedPacket?.lane?.sessionKey);

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
