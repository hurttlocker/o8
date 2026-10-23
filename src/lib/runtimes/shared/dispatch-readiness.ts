import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getApiBase, resolvePortInfo } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';
import { getDataDir } from '@/lib/data-dir-migration';

const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_WAIT_MS = 20_000;
const DEFAULT_STEP_MS = 2_000;
const READINESS_PATH = '/api/setup/status';

export interface DispatchBackendReadiness {
  ready: boolean;
  reason: string;
  apiBase: string;
  status?: number;
  transportCode?: string;
  portSource: 'env' | 'file' | 'default';
  apiPortFilePresent: boolean;
}

export interface DispatchBackendWaitResult {
  ready: boolean;
  reason: string;
  waitedMs: number;
  attempts: number;
  lastCheck: DispatchBackendReadiness;
}

interface WaitForDispatchBackendReadyOptions {
  maxWaitMs?: number;
  stepMs?: number;
  probeTimeoutMs?: number;
  check?: () => Promise<DispatchBackendReadiness>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

function dataDir(): string {
  return getDataDir();
}

function apiPortFilePresent(): boolean {
  return existsSync(join(dataDir(), 'api-port'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readinessUrl(apiBase: string): string {
  return new URL(READINESS_PATH, apiBase).toString();
}

const TRANSPORT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH',
  'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
]);

function transportCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const cause = 'cause' in error ? error.cause : undefined;
  for (const candidate of [error, cause]) {
    if (candidate && typeof candidate === 'object' && 'code' in candidate
      && typeof candidate.code === 'string' && TRANSPORT_CODES.has(candidate.code)) return candidate.code;
  }
  return undefined;
}

function probeTarget() {
  return {
    apiBase: getApiBase(),
    portSource: resolvePortInfo().source,
    apiPortFilePresent: apiPortFilePresent(),
  };
}

export async function isDispatchBackendReady(
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DispatchBackendReadiness> {
  return probeDispatchBackend(timeoutMs, probeTarget());
}

async function probeDispatchBackend(
  timeoutMs: number,
  base: ReturnType<typeof probeTarget>,
): Promise<DispatchBackendReadiness> {
  try {
    // Hardening #1562 requires an affirmative principal on EVERY gated API
    // call, loopback included — a bare probe now 401s forever and every
    // claude-code launch dies as "backend still warming (http_401)"
    // (live-hit 2026-07-16 during the runtime spawn sweep). This is a
    // server-side internal call, so present the operator ws-token like the
    // o8 backend does (ws-auth, the 603 fix).
    const response = await fetch(readinessUrl(base.apiBase), {
      cache: 'no-store',
      headers: { Authorization: `Bearer ${getOrCreateWsToken()}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) {
      return { ...base, ready: true, reason: 'http_200', status: response.status };
    }
    return {
      ...base,
      ready: false,
      reason: `http_${response.status}`,
      status: response.status,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const reason = name === 'TimeoutError' || name === 'AbortError'
      ? 'timeout'
      : 'fetch_failed';
    const code = transportCode(error);
    return { ...base, ready: false, reason, ...(code ? { transportCode: code } : {}) };
  }
}

export async function waitForDispatchBackendReady(
  options: WaitForDispatchBackendReadyOptions = {},
): Promise<DispatchBackendWaitResult> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const stepMs = options.stepMs ?? DEFAULT_STEP_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const wait = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let attempts = 0;
  let lastCheck: DispatchBackendReadiness = { ...probeTarget(), ready: false, reason: 'timeout' };

  while (true) {
    const remainingMs = maxWaitMs - Math.max(0, now() - startedAt);
    if (remainingMs <= 0) {
      return { ready: false, reason: lastCheck.reason,
        waitedMs: Math.max(0, now() - startedAt), attempts, lastCheck };
    }
    const budgetMs = Math.max(1, Math.min(probeTimeoutMs, remainingMs));
    const target = probeTarget();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // This is a read-only probe: an ignored AbortSignal cannot retain the
      // launch indefinitely, and a late response cannot authorize a spawn.
      lastCheck = await Promise.race([
        Promise.resolve().then(() => options.check ? options.check() : probeDispatchBackend(budgetMs, target)),
        new Promise<DispatchBackendReadiness>((resolve) => {
          timer = setTimeout(() => resolve({ ...target, ready: false, reason: 'timeout' }), budgetMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    attempts += 1;
    if (lastCheck.ready && now() - startedAt < maxWaitMs) break;
    if (lastCheck.ready) lastCheck = { ...target, ready: false, reason: 'timeout' };
    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= maxWaitMs) {
      return { ready: false, reason: lastCheck.reason, waitedMs: elapsedMs, attempts, lastCheck };
    }
    await wait(Math.min(stepMs, maxWaitMs - elapsedMs));
  }

  return {
    ready: true,
    reason: lastCheck.reason,
    waitedMs: Math.max(0, now() - startedAt),
    attempts,
    lastCheck,
  };
}

export async function ensureDispatchBackendReady(
  runtimeId: string,
  mode: string,
  launch?: { laneId: string; packetId?: string },
): Promise<DispatchBackendWaitResult> {
  const emit = launch ? (await import('@/lib/lane/registry')).appendEvent : null;
  const target = probeTarget();
  const step = { packetId: launch?.packetId, runtime: runtimeId, mode, step: 'backend_readiness' };
  if (launch && emit) emit(launch.laneId, 'runtime_launch_step', 'system', {
    ...step, phase: 'started', deadlineMs: DEFAULT_MAX_WAIT_MS,
    url: readinessUrl(target.apiBase), portSource: target.portSource,
    apiPortFilePresent: target.apiPortFilePresent,
  });
  const readiness = await waitForDispatchBackendReady();
  if (launch && emit) emit(launch.laneId, 'runtime_launch_step', 'system', {
    ...step, phase: readiness.ready ? 'completed' : 'failed',
    code: readiness.ready ? 'dispatch_backend_ready' : 'dispatch_backend_not_ready',
    reason: readiness.reason, elapsedMs: readiness.waitedMs, attempts: readiness.attempts,
    url: readinessUrl(readiness.lastCheck.apiBase), portSource: readiness.lastCheck.portSource,
    apiPortFilePresent: readiness.lastCheck.apiPortFilePresent,
    ...(readiness.lastCheck.transportCode ? { transportCode: readiness.lastCheck.transportCode } : {}),
  });
  if (!readiness.ready) {
    throw new DispatchBackendNotReadyError(readiness);
  }
  if (readiness.waitedMs > 0 || readiness.attempts > 1) {
    console.log(
      `[dispatch] waited ${readiness.waitedMs}ms for backend readiness before ${runtimeId} ${mode} (${readiness.reason})`,
    );
  }
  return readiness;
}

export class DispatchBackendNotReadyError extends Error {
  readonly code = 'dispatch_backend_not_ready';
  readonly reason: string;
  readonly waitedMs: number;
  readonly attempts: number;
  readonly url: string;
  readonly portSource: DispatchBackendReadiness['portSource'];
  readonly transportCode?: string;

  constructor(result: DispatchBackendWaitResult) {
    super(
      `[dispatch_backend_not_ready] Backend readiness failed at ${readinessUrl(result.lastCheck.apiBase)} after ${result.waitedMs}ms (${result.reason}${result.lastCheck.transportCode ? `; ${result.lastCheck.transportCode}` : ''}; port source: ${result.lastCheck.portSource}). Check the backend address and availability before retrying.`,
    );
    this.name = 'DispatchBackendNotReadyError';
    this.reason = result.reason;
    this.waitedMs = result.waitedMs;
    this.attempts = result.attempts;
    this.url = readinessUrl(result.lastCheck.apiBase);
    this.portSource = result.lastCheck.portSource;
    this.transportCode = result.lastCheck.transportCode;
  }
}
