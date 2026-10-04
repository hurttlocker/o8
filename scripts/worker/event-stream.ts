import { setTimeout as delay } from 'node:timers/promises';
import type { RemotePreviewRequest, RemotePreviewResponse, RemotePreviewService } from '../../src/lib/cloud/preview-contract';
import type { RemoteServiceSession } from '../../src/lib/cloud/review-service-contract';
import type { ThinkingEffort } from '../../src/lib/orchestrator/thinking-effort';

const INITIAL_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 1_600;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 12_000;
const LONG_POLL_WAIT_MS = REQUEST_TIMEOUT_MS - 2_000;
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'UND_ERR_SOCKET']);
const SERVICE_TRANSPORT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

function isRetryable(error: unknown) {
  if (!(error instanceof Error) || error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const code = (error as Error & { cause?: { code?: string } }).cause?.code;
  return error.message === 'fetch failed' || (typeof code === 'string' && RETRYABLE_CODES.has(code));
}

export function isTransientTransportError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const code = (error as Error & { cause?: { code?: string } }).cause?.code;
  return typeof code === 'string' && SERVICE_TRANSPORT_CODES.has(code);
}

async function fetchWithRetry(input: string, init: RequestInit): Promise<Response> {
  let backoff = INITIAL_BACKOFF_MS;
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  // A POST may have committed even when its acknowledgement was lost. Never
  // replay mutations without an event idempotency key in the server contract.
  const attempts = (init.method ?? 'GET').toUpperCase() === 'GET' ? MAX_ATTEMPTS : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await fetch(input, { ...init, signal }); } catch (error) {
      if (signal.aborted || attempt === attempts || !isRetryable(error)) throw error;
      await delay(backoff, undefined, { signal });
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
  launch: { prompt: string; model?: string; effort?: ThinkingEffort; packetId?: string; workMode?: string; remoteSource?: CloudRemoteSource; remoteManifestHash?: string; remotePreview?: RemotePreviewService; remoteServiceSession?: RemoteServiceSession; };
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

  async postEvent(job: Pick<CloudWorkerJob, 'id' | 'leaseToken'>, type: WorkerOutboundEventType, payload: Record<string, unknown>, signal?: AbortSignal) {
    const response = await fetchWithRetry(`${this.baseUrl}/api/cloud/worker-stream`, {
      method: 'POST', headers: this.headers(true), signal,
      body: JSON.stringify({ jobId: job.id, workerId: this.workerId, leaseToken: job.leaseToken, type, payload }),
    });
    if (!response.ok) throw responseError('/api/cloud/worker-stream', response);
    const body = await response.json() as { leaseExpiresAt?: unknown };
    return typeof body.leaseExpiresAt === 'string' ? body.leaseExpiresAt : null;
  }

  async pollOnce(cursor: number, signal?: AbortSignal): Promise<CloudWorkerJob | null> {
    // Leave time for the response to cross the network before the HTTP deadline.
    const params = new URLSearchParams({ cursor: String(cursor), workerId: this.workerId, waitMs: String(LONG_POLL_WAIT_MS) });
    const response = await fetchWithRetry(`${this.baseUrl}/api/cloud/worker-poll?${params.toString()}`, { method: 'GET', headers: this.headers(), signal });
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

  async pollControl(job: Pick<CloudWorkerJob, 'id' | 'leaseToken'>, signal?: AbortSignal): Promise<CloudWorkerControl | null> {
    const params = new URLSearchParams({ jobId: job.id, workerId: this.workerId, leaseToken: job.leaseToken });
    const response = await fetchWithRetry(`${this.baseUrl}/api/cloud/worker-control?${params.toString()}`, { method: 'GET', headers: this.headers(), signal });
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

  async pollPreview(job: CloudWorkerJob, signal: AbortSignal): Promise<RemotePreviewRequest | null> {
    const params = new URLSearchParams({ jobId: job.id, workerId: this.workerId, leaseToken: job.leaseToken, attempt: String(job.claimCount) });
    const response = await fetchWithRetry(`${this.baseUrl}/api/cloud/worker-preview?${params}`, { headers: this.headers(), signal });
    if (response.status === 204) return null;
    if (!response.ok) throw responseError('/api/cloud/worker-preview', response);
    return (await response.json() as { request: RemotePreviewRequest }).request;
  }

  async answerPreview(job: CloudWorkerJob, result: RemotePreviewResponse, signal: AbortSignal): Promise<void> {
    const response = await fetchWithRetry(`${this.baseUrl}/api/cloud/worker-preview`, {
      method: 'POST', headers: this.headers(true), signal,
      body: JSON.stringify({ jobId: job.id, workerId: this.workerId, leaseToken: job.leaseToken, attempt: job.claimCount, result }),
    });
    if (!response.ok) throw responseError('/api/cloud/worker-preview', response);
  }
}
