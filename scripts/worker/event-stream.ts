const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 1_600;
const MAX_ATTEMPTS = 5;
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET']);

function isRetryable(error: unknown) {
  if (!(error instanceof Error) || error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const code = (error as Error & { cause?: { code?: string } }).cause?.code;
  return error.message === 'fetch failed' || (typeof code === 'string' && RETRYABLE_CODES.has(code));
}

function delay(ms: number) { return new Promise<void>((resolve) => setTimeout(resolve, ms)); }

async function fetchWithRetry(input: string, init: RequestInit): Promise<Response> {
  let backoff = INITIAL_BACKOFF_MS;
  const deadline = AbortSignal.timeout(12_000);
  // A POST may have committed even when its acknowledgement was lost. Never
  // replay mutations without an event idempotency key in the server contract.
  const attempts = (init.method ?? 'GET').toUpperCase() === 'GET' ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await fetch(input, { ...init, signal: deadline }); } catch (error) {
      if (attempt === attempts || !isRetryable(error)) throw error;
      await delay(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
  throw new Error('[worker/cloud] retry loop exited unexpectedly');
}

function responseError(route: string, response: Response): Error {
  return new Error(`[worker/cloud] ${route} rejected with HTTP ${response.status}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface CloudRemoteSource { repoUrl: string; baseSha: string; branch: string; }

export interface CloudWorkerJob {
  id: string;
  cursor: number;
  leaseToken: string;
  leaseExpiresAt: string;
  claimCount: number;
  launch: { prompt: string; model?: string; packetId?: string; workMode?: string; remoteSource?: CloudRemoteSource; remoteManifestHash?: string; };
}

export interface CloudWorkerControl {
  id: string;
  type: 'steer' | 'abort';
  payload: unknown;
  deliveryToken: string;
}

export type WorkerOutboundEventType = 'chunk' | 'diff' | 'service' | 'completed' | 'errored' | 'heartbeat';

export interface EventStreamOptions { o8Url: string; workerKey: string; workerId: string; }

/** Client for the scoped `/api/cloud/*` worker protocol. */
export class EventStream {
  private readonly baseUrl: string;
  private readonly workerKey: string;
  private readonly workerId: string;

  constructor(options: EventStreamOptions) {
    this.baseUrl = options.o8Url.replace(/\/+$/, '');
    this.workerKey = options.workerKey;
    this.workerId = options.workerId;
  }

  private headers(json = false): HeadersInit {
    return { Authorization: `Bearer ${this.workerKey}`, 'Cache-Control': 'no-store', ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  async postEvent(job: Pick<CloudWorkerJob, 'id' | 'leaseToken'>, type: WorkerOutboundEventType, payload: Record<string, unknown>) {
    const response = await fetchWithRetry(`${this.baseUrl}/api/cloud/worker-stream`, {
      method: 'POST', headers: this.headers(true),
      body: JSON.stringify({ jobId: job.id, workerId: this.workerId, leaseToken: job.leaseToken, type, payload }),
    });
    if (!response.ok) throw responseError('/api/cloud/worker-stream', response);
    const body = await response.json() as { leaseExpiresAt?: unknown };
    return typeof body.leaseExpiresAt === 'string' ? body.leaseExpiresAt : null;
  }

  async pollOnce(cursor: number): Promise<CloudWorkerJob | null> {
    const params = new URLSearchParams({ cursor: String(cursor), workerId: this.workerId });
    const response = await fetchWithRetry(`${this.baseUrl}/api/cloud/worker-poll?${params.toString()}`, { method: 'GET', headers: this.headers() });
    if (response.status === 204 || response.status === 409) return null;
    if (!response.ok) throw responseError('/api/cloud/worker-poll', response);
    const data = await response.json() as { job?: unknown };
    if (!isRecord(data.job)) throw new Error('[worker/cloud] poll returned an invalid job payload');
    const job = data.job as Partial<CloudWorkerJob>;
    if (typeof job.id !== 'string' || !Number.isInteger(job.cursor) || typeof job.leaseToken !== 'string'
      || typeof job.leaseExpiresAt !== 'string' || !Number.isInteger(job.claimCount)
      || !isRecord(job.launch) || typeof job.launch.prompt !== 'string') {
      throw new Error('[worker/cloud] poll returned an invalid job payload');
    }
    return job as CloudWorkerJob;
  }

  async pollControl(job: Pick<CloudWorkerJob, 'id' | 'leaseToken'>): Promise<CloudWorkerControl | null> {
    const params = new URLSearchParams({ jobId: job.id, workerId: this.workerId, leaseToken: job.leaseToken });
    const response = await fetchWithRetry(`${this.baseUrl}/api/cloud/worker-control?${params.toString()}`, { method: 'GET', headers: this.headers() });
    if (response.status === 204) return null;
    if (!response.ok) throw responseError('/api/cloud/worker-control', response);
    const data = await response.json() as { control?: unknown };
    if (!isRecord(data.control)) throw new Error('[worker/cloud] control returned an invalid payload');
    const control = data.control as Partial<CloudWorkerControl>;
    if (typeof control.id !== 'string' || (control.type !== 'steer' && control.type !== 'abort') || typeof control.deliveryToken !== 'string') {
      throw new Error('[worker/cloud] control returned an invalid payload');
    }
    return control as CloudWorkerControl;
  }

  async acknowledgeControl(job: Pick<CloudWorkerJob, 'id' | 'leaseToken'>, control: CloudWorkerControl): Promise<void> {
    const response = await fetchWithRetry(`${this.baseUrl}/api/cloud/worker-control`, {
      method: 'POST', headers: this.headers(true),
      body: JSON.stringify({ jobId: job.id, workerId: this.workerId, leaseToken: job.leaseToken, controlId: control.id, deliveryToken: control.deliveryToken }),
    });
    if (!response.ok) throw responseError('/api/cloud/worker-control', response);
  }
}
