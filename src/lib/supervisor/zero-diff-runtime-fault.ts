/**
 * #2141 — telling a dead worker apart from a worker that had nothing to do.
 *
 * A completion with an empty worktree has two causes that are indistinguishable
 * from git alone:
 *   1. the runtime ERRORED before writing anything (the free-model rails that
 *      plan, narrate, then die on `opencode run error`), and
 *   2. the worker ran to a clean finish and legitimately changed nothing.
 *
 * The first is the most transient failure we have and the cheapest to retry —
 * there is no partial work to preserve. The second must NEVER be retried: a
 * packet whose correct answer is "nothing to change" would loop forever.
 * `agent-completion` used to collapse both into `zero_diff_failed` and retry
 * neither, which is why a flaky rail silently cost a third of a parallel
 * dispatch.
 *
 * The signal that separates them already exists: the normalized transcript
 * carries `error` events (`Codex run error` / `opencode run error`) and a
 * terminal `done` with an exit code. This module reads it, and owns the
 * bounded retry the `runtime_error` case earns.
 */
import { setLaneStatus } from '@/lib/lane/registry';
import type { Lane } from '@/lib/lane/types';
import { persistAttemptLearnings } from '@/lib/orchestrator/attempt-log';
import { withLockedState } from '@/lib/orchestrator/control-plane';
import { readSessionTranscriptEvents } from '@/lib/orchestrator/packet-transcript';
import type { TranscriptEvent } from '@/lib/orchestrator/transcript-normalizer';
import { markRalphRetryRequeued } from './post-completion-packet';

/**
 * Retries this fault class is allowed, per packet, across redispatches.
 *
 * One. A runtime that dies before its first write is failing for a transient
 * reason (endpoint blip, rate limit, killed process) that a single fresh
 * dispatch clears, or for a structural one (unreachable model, bad binding, a
 * prompt the rail cannot execute) that no number of dispatches clears. The
 * second identical failure is the evidence that it is structural, so the
 * budget stops there instead of burning a worktree and a full worker run per
 * cycle. The counter lives ON THE PACKET for the same reason as
 * {@link OrchestratorPacket.stallRetries}: a per-lane count resets every
 * redispatch and would never bound anything.
 */
export const ZERO_DIFF_RUNTIME_RETRY_CAP = 1;

export type ZeroDiffCause =
  /** The transcript shows the run errored — the empty worktree is the fallout. */
  | 'runtime_error'
  /** The run reached a clean terminal `done` and changed nothing on purpose. */
  | 'clean_no_op'
  /** No readable transcript, so the two cannot be told apart. */
  | 'indeterminate';

export interface ZeroDiffClassification {
  cause: ZeroDiffCause;
  detail: string;
}

export interface ZeroDiffTranscriptReadback {
  events: TranscriptEvent[];
  unsupportedReason?: string;
}

/**
 * Pure classifier over a normalized transcript.
 *
 * `indeterminate` is a real answer, not a fallback for `clean_no_op`: a runtime
 * with no normalized transcript (Gemini today) or an unreadable one gives us no
 * evidence either way, and guessing `clean_no_op` hides a dead worker while
 * guessing `runtime_error` retries a legitimate no-op. Both indeterminate and
 * clean completions stay terminal; only their labels differ, so the operator
 * can see which one they are looking at.
 */
export function classifyZeroDiffTranscript(
  readback: ZeroDiffTranscriptReadback,
): ZeroDiffClassification {
  if (readback.unsupportedReason) {
    return {
      cause: 'indeterminate',
      detail: `runtime transcript unavailable (${readback.unsupportedReason})`,
    };
  }

  const events = readback.events;
  if (events.length === 0) {
    return { cause: 'indeterminate', detail: 'runtime transcript is empty' };
  }

  let lastError: string | null = null;
  let lastDoneExitCode: number | null = null;
  for (const event of events) {
    if (event.type === 'error') lastError = event.message;
    else if (event.type === 'done') lastDoneExitCode = event.exitCode;
  }

  if (lastError) {
    return { cause: 'runtime_error', detail: lastError };
  }
  if (lastDoneExitCode !== null && lastDoneExitCode !== 0) {
    return { cause: 'runtime_error', detail: `runtime exited with code ${lastDoneExitCode}` };
  }
  if (lastDoneExitCode === 0) {
    return { cause: 'clean_no_op', detail: 'runtime finished cleanly without changing anything' };
  }
  // Events but no terminal marker: the run stopped without saying how.
  return { cause: 'indeterminate', detail: 'runtime transcript has no terminal event' };
}

/** Read + classify. Any read failure is `indeterminate`, never a guess. */
export async function readZeroDiffClassification(
  sessionKey: string | null | undefined,
): Promise<ZeroDiffClassification> {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    return { cause: 'indeterminate', detail: 'lane has no session binding' };
  }
  try {
    return classifyZeroDiffTranscript(await readSessionTranscriptEvents(normalized));
  } catch (error) {
    return {
      cause: 'indeterminate',
      detail: `runtime transcript could not be read (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}

export interface ZeroDiffRetryPlan {
  retry: boolean;
  /** Budget already spent before this decision. */
  retriesSpent: number;
  /** 1-based ordinal of the retry this plan authorizes, when it authorizes one. */
  retryNumber: number;
  cap: number;
}

/** Pure bound check — kept separate so the budget is testable without a packet. */
export function planZeroDiffRuntimeRetry(retriesSpent: number | undefined): ZeroDiffRetryPlan {
  const spent = Number.isFinite(retriesSpent) && (retriesSpent ?? 0) > 0
    ? Math.floor(retriesSpent as number)
    : 0;
  return {
    retry: spent < ZERO_DIFF_RUNTIME_RETRY_CAP,
    retriesSpent: spent,
    retryNumber: spent + 1,
    cap: ZERO_DIFF_RUNTIME_RETRY_CAP,
  };
}

export interface ZeroDiffRequeueResult {
  requeued: boolean;
  retryNumber: number;
  cap: number;
  /** Why the requeue did not happen, when it did not. */
  reason: 'requeued' | 'budget_spent' | 'packet_not_found' | 'requeue_failed';
}

/**
 * Spend one unit of the zero-diff runtime budget and put the packet back on the
 * queue, mirroring the verification-failure requeue (`markRalphRetryRequeued` +
 * `queueState: 'queued'` + `lane: null`) so the headless dispatcher picks it up
 * on its next tick. `attemptCount` is deliberately NOT advanced: this fault
 * produced no work to learn from, and spending the packet's shared attempt
 * budget on a dead rail would starve the verification retries that do.
 */
export async function requeueZeroDiffRuntimeFault(input: {
  lane: Lane;
  packetId: string | null | undefined;
  worktreePath: string;
  detail: string;
}): Promise<ZeroDiffRequeueResult> {
  const packetId = input.packetId?.trim();
  if (!packetId) {
    return { requeued: false, retryNumber: 0, cap: ZERO_DIFF_RUNTIME_RETRY_CAP, reason: 'packet_not_found' };
  }

  const { result: plan } = await withLockedState((state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet) return null;
    // An operator Stop is terminal for every relaunch path, this one included.
    if (packet.operatorStopped) return { ...planZeroDiffRuntimeRetry(packet.zeroDiffRuntimeRetries), retry: false };
    const decision = planZeroDiffRuntimeRetry(packet.zeroDiffRuntimeRetries);
    if (!decision.retry) return decision;
    const now = new Date().toISOString();
    packet.zeroDiffRuntimeRetries = decision.retryNumber;
    packet.queueState = 'queued';
    packet.status = 'queued';
    packet.blockedReason = null;
    packet.lastEventAt = now;
    packet.lastEventLabel = 'zero_diff_runtime_error_requeued';
    packet.lane = null;
    return decision;
  });

  if (!plan) {
    return { requeued: false, retryNumber: 0, cap: ZERO_DIFF_RUNTIME_RETRY_CAP, reason: 'packet_not_found' };
  }
  if (!plan.retry) {
    return { requeued: false, retryNumber: plan.retryNumber, cap: plan.cap, reason: 'budget_spent' };
  }

  try {
    markRalphRetryRequeued(input.lane.id, packetId);
  } catch (error) {
    console.error(`[supervisor] Zero-diff runtime retry requeue failed for packet ${packetId}:`, error);
    return { requeued: false, retryNumber: plan.retryNumber, cap: plan.cap, reason: 'requeue_failed' };
  }

  try {
    await persistAttemptLearnings(input.worktreePath, packetId, plan.retryNumber, {
      filesChanged: [],
      summary: `Worker runtime errored before writing any files: ${input.detail}. Retry ${plan.retryNumber}/${plan.cap}.`,
    });
  } catch (error) {
    // Non-fatal — the requeue already landed; the retry just loses its note.
    console.warn(`[supervisor] Failed to record zero-diff runtime learning for packet ${packetId}:`, error);
  }

  return { requeued: true, retryNumber: plan.retryNumber, cap: plan.cap, reason: 'requeued' };
}

/** Lane label + packet `blockedReason` per cause — the states must not collapse. */
const TERMINAL_MARKERS: Record<ZeroDiffCause, { laneLabel: string; blockedReason: string }> = {
  runtime_error: { laneLabel: 'zero_diff_runtime_error', blockedReason: 'worker_runtime_error' },
  clean_no_op: { laneLabel: 'zero_diff_failed', blockedReason: 'no_changes_produced' },
  indeterminate: { laneLabel: 'zero_diff_unclassified', blockedReason: 'no_changes_produced' },
};

/** Land a zero-diff completion in its terminal state, labelled by cause. */
export async function markZeroDiffTerminal(input: {
  lane: Lane;
  packetId: string | null | undefined;
  sessionKey: string;
  cause: ZeroDiffCause;
}): Promise<void> {
  const marker = TERMINAL_MARKERS[input.cause];
  const failedLane = setLaneStatus(input.lane.id, 'failed', 'system', marker.laneLabel);
  const packetId = input.packetId?.trim();
  if (!packetId) return;

  const now = new Date().toISOString();
  await withLockedState((state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId);
    if (!packet) return;
    packet.status = 'failed';
    packet.blockedReason = marker.blockedReason;
    packet.lastEventAt = now;
    packet.lastEventLabel = marker.laneLabel;
    if (packet.lane) {
      packet.lane = {
        ...packet.lane,
        laneId: failedLane?.id ?? input.lane.id,
        sessionKey: failedLane?.sessionKey ?? input.lane.sessionKey ?? input.sessionKey,
        lastEventAt: now,
        lastEventLabel: marker.laneLabel,
      };
    }
  });
}
