import {
  apiFetch,
  CliError,
  EXIT,
  SLOW_MUTATION_TIMEOUT_MS,
  type ApiResponse,
} from '../../api.js';
import type { ResolvedConfig } from '../../config.js';

interface InProgressReceipt {
  inProgress?: boolean;
  outcomeUnknown?: boolean;
  status?: string;
  note?: string;
}

export interface CorrelatedMutationEnvelope {
  ok?: boolean;
  result?: unknown;
}

const RECEIPT_POLL_MS = 250;

function receiptIsInProgress(status: number, data: CorrelatedMutationEnvelope | null): boolean {
  const topLevel = data as (InProgressReceipt & CorrelatedMutationEnvelope) | null;
  const result = data?.result && typeof data.result === 'object'
    ? data.result as InProgressReceipt
    : null;
  if (topLevel?.outcomeUnknown === true || result?.outcomeUnknown === true) return false;
  return status === 202
    || topLevel?.inProgress === true
    || topLevel?.status === 'in_progress'
    || topLevel?.status === 'queued'
    || result?.inProgress === true
    || result?.status === 'in_progress'
    || result?.status === 'queued';
}

function ambiguousTransportFailure(error: unknown): boolean {
  return error instanceof CliError
    && (error.ambiguous || error.code === 'network_error');
}

/**
 * Replays one body-bound CLI mutation until its persisted receipt is terminal.
 * A timeout or connection reset may happen after the server accepted the
 * mutation, so every replay keeps the exact caller-provided body.
 */
export async function fetchCorrelatedPacketMutation<T extends CorrelatedMutationEnvelope>(
  cfg: ResolvedConfig,
  path: string,
  body: Record<string, unknown>,
  options: { timeoutMs?: number; pollMs?: number; allowConflict?: boolean } = {},
): Promise<ApiResponse<T | null>> {
  const settleTimeoutMs = options.timeoutMs ?? SLOW_MUTATION_TIMEOUT_MS;
  const pollMs = options.pollMs ?? RECEIPT_POLL_MS;
  const deadline = Date.now() + settleTimeoutMs;
  let lastReceipt: ApiResponse<T | null> | null = null;

  while (true) {
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const receipt = await apiFetch<T>(cfg, path, {
        method: 'POST',
        timeoutMs: Math.min(settleTimeoutMs, remainingMs),
        allowConflict: options.allowConflict,
        body,
      });
      lastReceipt = receipt;
      const validEnvelope = receipt.data && typeof (receipt.data as { ok?: unknown }).ok === 'boolean';
      if (validEnvelope && !receiptIsInProgress(receipt.status, receipt.data)) return receipt;
    } catch (error) {
      if (!ambiguousTransportFailure(error)) throw error;
    }

    if (Date.now() >= deadline) {
      const lastResult = lastReceipt?.data?.result && typeof lastReceipt.data.result === 'object'
        ? lastReceipt.data.result as InProgressReceipt
        : null;
      const note = lastResult?.note;
      const idempotencyKey = typeof body.idempotencyKey === 'string'
        ? body.idempotencyKey.trim()
        : typeof body.clientMutationId === 'string'
          ? body.clientMutationId.trim()
          : '';
      throw new CliError(
        'mutation_receipt_unsettled',
        note || `The server accepted ${path}, but its final receipt is still unavailable.`,
        EXIT.SERVER_TIMEOUT,
        idempotencyKey
          ? `Do not mint a new mutation. Retry this command with --idempotency-key ${idempotencyKey} to poll the same receipt.`
          : 'Do not issue a second mutation with a new id; inspect the original action receipt before retrying.',
        true,
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs));
  }
}
