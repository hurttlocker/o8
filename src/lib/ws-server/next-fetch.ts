/**
 * Next.js HTTP fetch helpers for the ws-server → Next API hop.
 *
 * ws-server reads sync state from the Next.js backend over loopback HTTP. This
 * module owns the origin resolution, retry/backoff, and JSON envelope handling.
 * Extracted faithfully from the ws-server monolith — no behavior change.
 *
 * The ws auth token is sourced from the same `getOrCreateWsToken()` the entry
 * uses and cached on first call (getOrCreateWsToken does a file read each time).
 */

import { getApiBase } from '@/lib/panel/api-port';
import { getOrCreateWsToken } from '@/lib/ws-auth';

/** Default per-request timeout (ms). Also used by the entry's fetchSync probe. */
export const FETCH_TIMEOUT_MS = 8_000;
const NEXT_FETCH_MAX_ATTEMPTS = 5;
const NEXT_FETCH_INITIAL_BACKOFF_MS = 100;

const RETRYABLE_NEXT_FETCH_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
]);

let cachedWsToken: string | null = null;
function wsToken(): string {
  return (cachedWsToken ??= getOrCreateWsToken());
}

function getNextOrigin(): string {
  return process.env.NEXT_ORIGIN ?? getApiBase();
}

export function buildNextUrl(pathname: string, searchParams?: URLSearchParams): string {
  const query = searchParams && searchParams.size > 0 ? `?${searchParams.toString()}` : '';
  return `${getNextOrigin()}${pathname}${query}`;
}

function getNextFetchErrorCode(error: Error): string | null {
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object') return null;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function isRetryableNextFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return false;
  const code = getNextFetchErrorCode(error);
  return error.message === 'fetch failed' || (code !== null && RETRYABLE_NEXT_FETCH_CODES.has(code));
}

function delayNextFetchRetry(delayMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

export async function fetchWithRetry(input: string, init: RequestInit): Promise<Response> {
  let backoffMs = NEXT_FETCH_INITIAL_BACKOFF_MS;

  for (let attempt = 1; attempt <= NEXT_FETCH_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      if (attempt === NEXT_FETCH_MAX_ATTEMPTS || !isRetryableNextFetchError(error)) {
        throw error;
      }

      await delayNextFetchRetry(backoffMs);
      backoffMs *= 2;
    }
  }

  throw new Error('[ws-server] internal fetch retry loop exited unexpectedly');
}

export async function fetchNextJson<T>(
  pathname: string,
  options: {
    method?: 'GET' | 'POST' | 'DELETE';
    searchParams?: URLSearchParams;
    body?: unknown;
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${wsToken()}`,
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetchWithRetry(buildNextUrl(pathname, options.searchParams), {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload
      ? String((payload as { error?: string }).error ?? '')
      : '';
    throw new Error(error || `${pathname} failed (${response.status})`);
  }

  return payload as T;
}
