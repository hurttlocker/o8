/**
 * Reconcile a reset_packet / retry_packet reservation whose owner exited before
 * its receipt was persisted (#2313).
 *
 * The idempotency store calls this ONLY for a confirmed-dead owner; a live or
 * unknown owner stays held with no reconciliation attempted. Everything here is
 * refuse-by-default. A matching packet, a current reviewing lane, timestamp
 * proximity, or a newer generation are NOT evidence that this request succeeded.
 *
 * **Recovery only ever continues committed-work salvage.** It never runs the
 * generation-scoped reset fallback, not even under the original guard: that
 * path archives lanes, prunes worktrees and deletes branches, and whether an
 * interrupted owner already performed some of it is exactly what is unknown. If
 * a committed candidate cannot be proven, the request is held with a precise
 * reason — never quietly reset.
 *
 * Evidence precedence — the journal always wins:
 *
 *  - `completed`  — replay the recorded receipt, after validating its shape and
 *                   that it describes this packet. Read-only.
 *  - `binding`    — a partial bind may exist. Hold with no further side
 *                   effects; a later lane cannot establish request ownership.
 *  - `guarded`    — resume salvage under the guard the request recorded.
 *  - `started`    — the request named a generation before stamping it. If the
 *                   packet still carries THAT generation the hold landed, so the
 *                   guard is rebuilt from it. Caller evidence never overrides it.
 *  - `absent`     — a reservation predating the journal. Only then may the
 *                   operator attest, and only with BOTH the expected generation
 *                   and the exact recorded candidate lane.
 *  - `unreadable` — fail closed.
 */

import { withPacketLifecycleMutationLock } from '@/lib/orchestrator/lifecycle-mutation-lock';
import { attemptCommittedWorkSalvage } from './committed-work-salvage';
import { resetBindCheckpointRecorder } from './reset';
import {
  resetFailureReceipt,
  resetReceiptPacketId,
  resetSuccessReceipt,
  type ResetReceipt,
} from './reset-receipt';
import {
  readResetRequestJournal,
  recordResetRequestHold,
  writeResetRequestJournal,
  type ResetRequestJournalEntry,
} from './reset-recovery-journal';
import {
  rehydrateRetrySalvageGuard,
  retrySalvageGuardIsCurrent,
  type RetrySalvageGuard,
} from './retry-salvage';

/**
 * Operator attestation for a reservation with no correlation journal. Both
 * fields are required together: the generation proves WHICH request is being
 * recovered, and the candidate lane proves WHICH committed work it was about
 * to preserve. Neither alone is enough.
 */
export interface ResetRecoveryEvidence {
  expectedGeneration: string;
  expectedCandidateLaneId: string;
}

export type ResetRecoveryEvidenceParse =
  | { ok: true; evidence: ResetRecoveryEvidence | undefined }
  | { ok: false; message: string };

const EVIDENCE_FIELDS = new Set(['expectedGeneration', 'expectedCandidateLaneId']);

/**
 * Parse the request's optional `recovery` block strictly. Malformed or partial
 * attestation is rejected outright rather than silently ignored, so a caller
 * can never believe it supplied evidence that was never applied.
 */
export function parseResetRecoveryEvidence(value: unknown): ResetRecoveryEvidenceParse {
  if (value === undefined || value === null) return { ok: true, evidence: undefined };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, message: 'recovery must be an object.' };
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !EVIDENCE_FIELDS.has(key));
  if (unknown.length > 0) {
    return { ok: false, message: `recovery has unsupported field(s): ${unknown.join(', ')}.` };
  }
  const generation = typeof record.expectedGeneration === 'string' ? record.expectedGeneration.trim() : '';
  const candidateLaneId = typeof record.expectedCandidateLaneId === 'string'
    ? record.expectedCandidateLaneId.trim()
    : '';
  if (!generation || !candidateLaneId) {
    return {
      ok: false,
      message: 'recovery requires both expectedGeneration and expectedCandidateLaneId as non-empty strings.',
    };
  }
  return { ok: true, evidence: { expectedGeneration: generation, expectedCandidateLaneId: candidateLaneId } };
}

export interface ReconcileResetRequestInput {
  packetId: string;
  requestKey: string;
  clearWorktree: boolean;
  reason?: string;
  evidence?: ResetRecoveryEvidence;
}

type Correlation =
  | { kind: 'replay'; receipt: ResetReceipt }
  | { kind: 'partial-bind' }
  | { kind: 'resume'; generation: string; guard: RetrySalvageGuard | null; requireCandidateLaneId: string | null }
  | { kind: 'refuse'; reason: string };

function candidateLaneIdOf(guard: RetrySalvageGuard): string | null {
  return guard.candidateLane?.id ?? null;
}

function evidenceContradictsJournal(
  entry: ResetRequestJournalEntry,
  evidence: ResetRecoveryEvidence,
): string | null {
  if (evidence.expectedGeneration !== entry.generation) {
    return "the supplied generation does not match the request's recorded generation";
  }
  const recordedCandidate = entry.bind?.candidateLaneId
    ?? (entry.guard ? candidateLaneIdOf(entry.guard) : null);
  if (recordedCandidate !== null && evidence.expectedCandidateLaneId !== recordedCandidate) {
    return "the supplied candidate lane does not match the request's recorded candidate";
  }
  return null;
}

/** Decide what durable evidence permits, without touching packet state. */
function correlate(input: ReconcileResetRequestInput): Correlation {
  const evidence = input.evidence;
  const journal = readResetRequestJournal(input.requestKey);
  if (journal.status === 'unreadable') {
    return { kind: 'refuse', reason: `the request's correlation record is unusable — ${journal.reason}` };
  }
  if (journal.status === 'absent') {
    return evidence
      ? {
          kind: 'resume',
          generation: evidence.expectedGeneration,
          guard: null,
          requireCandidateLaneId: evidence.expectedCandidateLaneId,
        }
      : {
          kind: 'refuse',
          reason: 'the request has no correlation record, and legacy recovery requires both the expected generation and the exact recorded candidate lane',
        };
  }

  const { entry } = journal;
  if (entry.packetId !== input.packetId || entry.clearWorktree !== input.clearWorktree) {
    return { kind: 'refuse', reason: 'the correlation record describes a different request' };
  }
  // Caller evidence may confirm the journal; it may never replace or contradict
  // it — including for a replay, which must not answer an unrelated operation.
  if (evidence) {
    const contradiction = evidenceContradictsJournal(entry, evidence);
    if (contradiction) return { kind: 'refuse', reason: contradiction };
  }
  if (entry.phase === 'completed') {
    const receipt = entry.receipt;
    if (!receipt) return { kind: 'refuse', reason: 'the completed correlation record has no receipt' };
    const receiptPacketId = resetReceiptPacketId(receipt);
    if (receiptPacketId !== null && receiptPacketId !== input.packetId) {
      return { kind: 'refuse', reason: 'the recorded receipt describes a different packet' };
    }
    return { kind: 'replay', receipt };
  }
  if (entry.phase === 'binding') {
    // Never falls through to the guarded or legacy paths: a partial bind may
    // already exist and rebinding could duplicate a review lane.
    return entry.guard && entry.bind
      ? { kind: 'partial-bind' }
      : { kind: 'refuse', reason: 'the interrupted-bind record is incomplete' };
  }
  if (entry.phase === 'guarded') {
    const guard = entry.guard ?? null;
    if (!guard || guard.generation !== entry.generation) {
      return { kind: 'refuse', reason: 'the recorded guard does not match the recorded generation' };
    }
    return {
      kind: 'resume',
      generation: entry.generation,
      guard,
      requireCandidateLaneId: evidence?.expectedCandidateLaneId ?? null,
    };
  }
  // `started`: the hold may or may not have landed. The packet itself decides.
  return {
    kind: 'resume',
    generation: entry.generation,
    guard: null,
    requireCandidateLaneId: evidence?.expectedCandidateLaneId ?? null,
  };
}

function hold(input: ReconcileResetRequestInput, reason: string): null {
  console.warn(`[reset-recovery] holding ${input.packetId}: ${reason}`);
  recordResetRequestHold(input.requestKey, reason);
  return null;
}

function recordCompletion(
  input: ReconcileResetRequestInput,
  generation: string,
  receipt: ResetReceipt,
): ResetReceipt {
  writeResetRequestJournal(input.requestKey, {
    phase: 'completed',
    packetId: input.packetId,
    clearWorktree: input.clearWorktree,
    generation,
    receipt,
  });
  return receipt;
}

export async function reconcileUnresolvedResetRequest(
  input: ReconcileResetRequestInput,
): Promise<ResetReceipt | null> {
  const correlation = correlate(input);
  if (correlation.kind === 'refuse') return hold(input, correlation.reason);
  if (correlation.kind === 'replay') return correlation.receipt;

  return withPacketLifecycleMutationLock(input.packetId, async ({ contendedByLiveIntent }) => {
    // Re-read under the lease, after any wait. A duplicate that raced us may
    // have settled the request while we queued, and both callers must receive
    // the same terminal receipt rather than a false held outcome. Reclaiming
    // the dead owner's own abandoned lease is not contention, so this comes
    // before the newer-intent check.
    const raced = correlate(input);
    if (raced.kind === 'replay') return raced.receipt;
    if (raced.kind === 'refuse') return hold(input, raced.reason);
    // A queued in-process mutation or a lease owner that could not be proven
    // dead is newer intent; never apply a resumed decision behind it.
    if (contendedByLiveIntent) {
      return hold(input, 'a newer lifecycle mutation for this packet is queued or running');
    }

    if (raced.kind === 'partial-bind') {
      return hold(input, 'partial bind remains held because no completed receipt proves its effects; no lane or packet state was changed');
    }

    if (input.clearWorktree) {
      return hold(input, 'the unfinished worktree-clearing request remains held; cleanup is never resumed');
    }

    const guard = raced.guard ?? await rehydrateRetrySalvageGuard(input.packetId, raced.generation);
    if (!guard) {
      return hold(input, `the packet no longer carries the request's generation ${raced.generation}`);
    }
    if (raced.requireCandidateLaneId && candidateLaneIdOf(guard) !== raced.requireCandidateLaneId) {
      return hold(input, 'the packet\'s candidate lane does not match the attested candidate');
    }
    if (!await retrySalvageGuardIsCurrent(input.packetId, guard)) {
      return hold(input, 'the packet no longer matches the hold this request recorded');
    }

    const resumeInput = {
      packetId: input.packetId,
      reason: input.reason,
      clearWorktree: input.clearWorktree,
      recovery: { requestKey: input.requestKey },
    };
    let attempt: Awaited<ReturnType<typeof attemptCommittedWorkSalvage>>;
    try {
      attempt = await attemptCommittedWorkSalvage(
        resumeInput,
        guard,
        resetBindCheckpointRecorder(resumeInput, guard),
      );
    } catch (error) {
      // Confirmed-retirement failures are the original request's own terminal
      // outcomes; finalize the same receipt the live path would have.
      return recordCompletion(input, guard.generation, resetFailureReceipt(error));
    }
    if (attempt.kind === 'unproven') {
      return hold(
        input,
        'no committed candidate could be proven for this request; the generation-scoped reset is never resumed',
      );
    }
    return recordCompletion(input, guard.generation, resetSuccessReceipt(attempt.result));
  });
}
