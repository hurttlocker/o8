import {
  ResetCleanupFailedError,
  ResetKillUnconfirmedError,
  ResetSessionArchiveUnconfirmedError,
  type ResetCleanupFailureResult,
} from './reset-errors';

/**
 * Terminal shape of one reset_packet / retry_packet request (#2313).
 *
 * The route used to build this inline, which meant the ONLY copy of a request's
 * outcome lived in the idempotency row. Recovery needs the same mapping from a
 * durable journal entry, so both the live route and the reconciler share these
 * pure functions — a replayed receipt is byte-identical to the original.
 */
export interface ResetPacketResult {
  reset: boolean;
  salvaged: boolean;
  packetId: string;
  referenceLabel: string;
  worktreePruned: boolean;
  branchDeleted: boolean;
  note: string;
  laneId?: string;
  partial?: boolean;
}

export interface ResetFailureReceipt {
  ok: false;
  code: string;
  message: string;
  status: number;
  result?: ResetCleanupFailureResult;
}

export type ResetReceipt =
  | { ok: true; result: ResetPacketResult }
  | ResetFailureReceipt;

export function resetFailureReceipt(error: unknown): ResetFailureReceipt {
  const message = error instanceof Error ? error.message : 'Unable to reset packet.';
  if (error instanceof ResetKillUnconfirmedError) return { ok: false, code: 'kill_unconfirmed', message, status: 409 };
  if (error instanceof ResetSessionArchiveUnconfirmedError) {
    return { ok: false, code: 'session_archive_unconfirmed', message, status: 409 };
  }
  if (error instanceof ResetCleanupFailedError) {
    return { ok: false, code: 'worktree_cleanup_failed', message, status: 409, result: error.result };
  }
  return { ok: false, code: 'reset_failed', message, status: 500 };
}

/**
 * A reset that neither reset nor salvaged the packet found a newer generation
 * and deliberately left it alone — that is a 409, not a success.
 */
export function resetSuccessReceipt(result: ResetPacketResult): ResetReceipt {
  if (result.reset === false && result.salvaged !== true) {
    return { ok: false, code: 'reset_state_changed', message: result.note, status: 409 };
  }
  return { ok: true, result };
}

function isResetPacketResult(value: unknown): value is ResetPacketResult {
  if (!value || typeof value !== 'object') return false;
  const result = value as Record<string, unknown>;
  return typeof result.reset === 'boolean'
    && typeof result.salvaged === 'boolean'
    && typeof result.packetId === 'string'
    && typeof result.referenceLabel === 'string'
    && typeof result.worktreePruned === 'boolean'
    && typeof result.branchDeleted === 'boolean'
    && typeof result.note === 'string'
    && (result.laneId === undefined || typeof result.laneId === 'string')
    && (result.partial === undefined || typeof result.partial === 'boolean');
}

/**
 * Validate a receipt read back from durable storage. A replayed receipt decides
 * what the operator is told happened to a real packet, so it is parsed, not
 * cast: an unrecognized shape must fail closed rather than become a success.
 */
export function isResetReceipt(value: unknown): value is ResetReceipt {
  if (!value || typeof value !== 'object') return false;
  const receipt = value as Record<string, unknown>;
  if (receipt.ok === true) {
    // Semantic, not just structural: `resetSuccessReceipt` maps a result that
    // neither reset nor salvaged to a 409, so a stored ok:true carrying one is
    // not a receipt this code could have written and must not replay as success.
    if (!isResetPacketResult(receipt.result)) return false;
    return receipt.result.reset === true || receipt.result.salvaged === true;
  }
  if (receipt.ok !== false) return false;
  return typeof receipt.code === 'string'
    && typeof receipt.message === 'string'
    && typeof receipt.status === 'number'
    && (receipt.result === undefined || isResetPacketResult(receipt.result));
}

/** The packet a receipt describes, for correlating a replay to its request. */
export function resetReceiptPacketId(receipt: ResetReceipt): string | null {
  if (receipt.ok) return receipt.result.packetId;
  return receipt.result ? receipt.result.packetId : null;
}
