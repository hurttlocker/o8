/**
 * The committed-work half of a retry salvage, shared by the live reset and by
 * the recovery of an interrupted request (#2313).
 *
 * A live reset that cannot prove a committed candidate falls through to the
 * generation-scoped cleanup. A RESUMED request must not: the completion of that
 * cleanup's archival and worktree effects is exactly what is unknown after an
 * owner exits, so recovery stops at `unproven` and holds. Both paths therefore
 * share this attempt and diverge only on what `unproven` means to them.
 */

import { LaneSessionArchiveUnconfirmedError } from '@/lib/lane/reap-sessions';
import { supersedeDurableApprovedReviews } from '@/lib/lane/durable-review-approval';
import {
  bindCommittedRetryWork,
  findCommittedRetryWork,
  markRetrySalvageKillUnconfirmed,
  markRetrySalvageSessionArchiveUnconfirmed,
  RetrySalvageKillUnconfirmedError,
  RetrySalvageStateChangedError,
  type RetrySalvage,
  type RetrySalvageBindCheckpoint,
  type RetrySalvageGuard,
} from './retry-salvage';
import { ResetKillUnconfirmedError, ResetSessionArchiveUnconfirmedError } from './reset-errors';
import type { ResetPacketResult } from './reset-receipt';
import { log } from './shared';
import type { ResetPacketInput } from './types';

export type CommittedWorkSalvageAttempt =
  /** Committed work was proven and bound to a review lane. */
  | { kind: 'salvaged'; result: ResetPacketResult }
  /** No committed candidate could be proven for this guard. */
  | { kind: 'unproven' }
  /** The packet or its lane moved while probing; nothing was touched. */
  | { kind: 'changed'; result: ResetPacketResult };

export function retrySalvageResult(packetId: string, salvage: RetrySalvage): ResetPacketResult {
  return {
    reset: false,
    salvaged: true,
    packetId,
    referenceLabel: salvage.referenceLabel,
    worktreePruned: false,
    branchDeleted: false,
    laneId: salvage.laneId,
    note: `Packet ${salvage.referenceLabel} already had a clean committed result. Its existing worktree is preserved and awaiting review; no worker was relaunched.`,
  };
}

/**
 * Probe for clean committed work under `guard` and bind it for review.
 *
 * Throws the same confirmed-retirement failures the live reset throws, so both
 * callers finalize identical receipts.
 */
export async function attemptCommittedWorkSalvage(
  input: ResetPacketInput,
  guard: RetrySalvageGuard,
  beforeBind?: (checkpoint: RetrySalvageBindCheckpoint) => void,
): Promise<CommittedWorkSalvageAttempt> {
  let candidate: Awaited<ReturnType<typeof findCommittedRetryWork>> = null;
  try {
    candidate = await findCommittedRetryWork(input, guard);
  } catch (error) {
    if (!(error instanceof RetrySalvageKillUnconfirmedError)) throw error;
    await markRetrySalvageKillUnconfirmed(input.packetId, guard);
    throw new ResetKillUnconfirmedError(error.message);
  }
  if (!candidate) return { kind: 'unproven' };

  let salvage: RetrySalvage;
  try {
    salvage = await bindCommittedRetryWork(input, guard, candidate, beforeBind);
  } catch (error) {
    if (error instanceof LaneSessionArchiveUnconfirmedError) {
      await markRetrySalvageSessionArchiveUnconfirmed(input.packetId, guard);
      throw new ResetSessionArchiveUnconfirmedError(error.message);
    }
    if (!(error instanceof RetrySalvageStateChangedError)) throw error;
    log(error.message);
    return {
      kind: 'changed',
      result: {
        reset: false,
        salvaged: false,
        packetId: input.packetId,
        referenceLabel: guard.referenceLabel,
        worktreePruned: false,
        branchDeleted: false,
        note: error.message,
      },
    };
  }
  await supersedeDurableApprovedReviews(input.packetId, 'Superseded by retry salvage.');
  log(`Retry salvaged committed work for ${salvage.referenceLabel} (${input.packetId}) into lane ${salvage.laneId}.`);
  return { kind: 'salvaged', result: retrySalvageResult(input.packetId, salvage) };
}
