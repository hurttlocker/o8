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

export async function isDispatchBackendReady(
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<DispatchBackendReadiness> {
  const portInfo = resolvePortInfo();
  const apiBase = getApiBase();
  const base = {
    apiBase,
    portSource: portInfo.source,
    apiPortFilePresent: apiPortFilePresent(),
  };

  try {
    // Hardening #1562 requires an affirmative principal on EVERY gated API
    // call, loopback included — a bare probe now 401s forever and every
    // claude-code launch dies as "backend still warming (http_401)"
    // (live-hit 2026-07-16 during the runtime spawn sweep). This is a
    // server-side internal call, so present the operator ws-token like the
    // o8 backend does (ws-auth, the 603 fix).
    const response = await fetch(readinessUrl(apiBase), {
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
    return { ...base, ready: false, reason };
  }
}

export async function waitForDispatchBackendReady(
  options: WaitForDispatchBackendReadyOptions = {},
): Promise<DispatchBackendWaitResult> {
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const stepMs = options.stepMs ?? DEFAULT_STEP_MS;
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const check = options.check ?? (() => isDispatchBackendReady(probeTimeoutMs));
  const wait = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let attempts = 0;
  let lastCheck = await check();
  attempts += 1;

  while (!lastCheck.ready) {
    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= maxWaitMs) {
      return {
        ready: false,
        reason: lastCheck.reason,
        waitedMs: elapsedMs,
        attempts,
        lastCheck,
      };
    }

    await wait(Math.min(stepMs, maxWaitMs - elapsedMs));
    lastCheck = await check();
    attempts += 1;
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
): Promise<DispatchBackendWaitResult> {
  const readiness = await waitForDispatchBackendReady();
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

  constructor(result: DispatchBackendWaitResult) {
    super(
      `Dispatch backend is still warming after ${result.waitedMs}ms (${result.reason}); retry the launch once the o8 server is ready.`,
    );
    this.name = 'DispatchBackendNotReadyError';
    this.reason = result.reason;
    this.waitedMs = result.waitedMs;
    this.attempts = result.attempts;
  }
}
