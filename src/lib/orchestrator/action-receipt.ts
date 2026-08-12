export interface ActionReceiptLike {
  inProgress?: unknown;
  outcomeUnknown?: unknown;
  status?: unknown;
}

export interface CorrelatedActionPayload extends ActionReceiptLike {
  ok?: unknown;
  result?: ActionReceiptLike | null;
}

export interface CorrelatedActionReceipt<Payload> {
  response: Response;
  payload: Payload | null;
}

export class CorrelatedActionUnsettledError extends Error {
  constructor(cause?: unknown) {
    super('The action is still running, but its final receipt is temporarily unavailable.', { cause });
    this.name = 'CorrelatedActionUnsettledError';
  }
}

const DEFAULT_RECEIPT_WAIT_MS = 5 * 60_000;
const DEFAULT_RECEIPT_POLL_MS = 750;

function waitForReceiptPoll(delayMs: number, signal?: AbortSignal | null) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(handle);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function actionReceiptIsInProgress(
  httpStatus: number,
  result: ActionReceiptLike | null | undefined,
): boolean {
  return result?.outcomeUnknown !== true && (httpStatus === 202
    || result?.inProgress === true
    || result?.status === 'in_progress');
}

/**
 * Replays one body-bound mutation until its persisted receipt is terminal.
 * Every poll reuses the caller's exact body and mutation id, so it cannot
 * launch a second action while the first request is still running.
 */
export async function fetchCorrelatedActionReceipt<Payload extends CorrelatedActionPayload>(
  input: RequestInfo | URL,
  init: RequestInit,
  options: { timeoutMs?: number; pollMs?: number; fetch?: typeof fetch } = {},
): Promise<CorrelatedActionReceipt<Payload>> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_RECEIPT_WAIT_MS);
  let receipt: CorrelatedActionReceipt<Payload> | null = null;
  let transportError: unknown = null;
  do {
    try {
      const response = await (options.fetch ?? fetch)(input, init);
      const payload = await response.json().catch(() => null) as Payload | null;
      receipt = { response, payload };
      transportError = null;
      if (!response.ok) return receipt;
      const terminalEnvelope = payload && typeof payload.ok === 'boolean';
      if (terminalEnvelope && !actionReceiptIsInProgress(response.status, payload.result ?? payload)) return receipt;
    } catch (error) {
      if (init.signal?.aborted) throw error;
      transportError = error;
    }
    if (Date.now() >= deadline) {
      throw new CorrelatedActionUnsettledError(transportError);
    }
    await waitForReceiptPoll(options.pollMs ?? DEFAULT_RECEIPT_POLL_MS, init.signal);
  } while (true);
}

export function correlatedActionIsUnsettled(error: unknown): error is CorrelatedActionUnsettledError {
  return error instanceof CorrelatedActionUnsettledError;
}
