const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 1_600;
const MAX_ATTEMPTS = 5;
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
]);

function isRetryable(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const code = (error as Error & { cause?: { code?: string } }).cause?.code;
  if (error.message === 'fetch failed') return true;
  return typeof code === 'string' && RETRYABLE_CODES.has(code);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(input: string, init: RequestInit): Promise<Response> {
  let backoff = INITIAL_BACKOFF_MS;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (attempt === MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await delay(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  throw new Error('[worker/event-stream] retry loop exited unexpectedly');
}

export interface EventStreamOptions {
  o8Url: string;
  token: string;
}

export type WorkerOutboundEventType = 'progress' | 'branch_pushed' | 'completed' | 'errored';

export class EventStream {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(options: EventStreamOptions) {
    this.baseUrl = options.o8Url.replace(/\/+$/, '');
    this.token = options.token;
  }

  async postEvent(runId: string, type: WorkerOutboundEventType, payload: Record<string, unknown>) {
    const body = JSON.stringify({ runId, type, payload });
    try {
      const response = await fetchWithRetry(`${this.baseUrl}/api/worker/event`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.token}`,
        },
        body,
      });
      if (!response.ok) {
        console.error(`[worker/event-stream] POST /event returned ${response.status} for ${type}`);
      }
    } catch (error) {
      console.error(
        `[worker/event-stream] POST /event failed after retries for ${type}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async pollOnce(): Promise<unknown | null> {
    try {
      const response = await fetchWithRetry(`${this.baseUrl}/api/worker/poll`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Cache-Control': 'no-store',
        },
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(`[worker/event-stream] poll rejected: ${response.status}`);
      }
      if (!response.ok) {
        console.warn(`[worker/event-stream] poll returned ${response.status}`);
        return null;
      }
      const data = (await response.json()) as { event?: unknown };
      return data?.event ?? null;
    } catch (error) {
      console.error(
        `[worker/event-stream] poll failed:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }
}
