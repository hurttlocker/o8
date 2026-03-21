/**
 * Gateway client — fetches agent/session data from the OpenClaw gateway.
 *
 * Strategy (resilient to OpenClaw version changes):
 *   1. Use the official Gateway health/session-history HTTP endpoints when available
 *   2. Use the official CLI status command for sessions/agents
 *
 * This ensures Cortex IDE works on ANY version of OpenClaw.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const execFileAsync = promisify(execFile);

// ── Config ──

interface GatewayConfig {
  port: number;
  token?: string;
}

let cachedConfig: GatewayConfig | null = null;
let configLoadedAt = 0;
const CONFIG_MAX_AGE_MS = 30_000; // Re-read config every 30s (catches token changes, restarts)
const REST_STATUS_TIMEOUT_MS = 3_000;
const CLI_STATUS_TIMEOUT_MS = 30_000;
const CLI_COLD_START_WAIT_MS = 500;
const CLI_FRESH_MAX_AGE_MS = 5_000;
const CLI_BACKOFF_BASE_MS = 5_000;
const CLI_BACKOFF_MAX_MS = 120_000;
const CLI_STATUS_ERROR_LOG_COOLDOWN_MS = 60_000;
let loggedStatusCompatibilityNote = false;

// ── CLI circuit breaker + concurrency limiter (#140) ──

const CLI_MAX_CONCURRENT = 2;
const CLI_CIRCUIT_BREAKER_THRESHOLD = 3;
const CLI_CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

let cliInFlight = 0;
let cliConsecutiveFailures = 0;
let cliCircuitOpenUntil = 0;

function loadConfig(): GatewayConfig {
  const now = Date.now();
  // Re-read config periodically — catches token changes and gateway restarts
  if (cachedConfig && (now - configLoadedAt) < CONFIG_MAX_AGE_MS) {
    return cachedConfig;
  }
  try {
    const home = process.env.HOME || homedir();
    const raw = readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf-8');
    const config = JSON.parse(raw);
    const token = config?.gateway?.auth?.token ?? '';
    cachedConfig = {
      port: config?.gateway?.port ?? 18789,
      token,
    };
    configLoadedAt = now;
    if (!token) {
      console.warn('[gateway-client] No auth token found in openclaw.json — REST API calls will 401');
    }
  } catch {
    cachedConfig = { port: 18789, token: '' };
    configLoadedAt = now;
  }
  return cachedConfig;
}

// ── REST API (primary — fast path) ──

async function fetchGatewayHttpJson<T>(pathname: string, params?: Record<string, string>): Promise<T | null> {
  const attempt = async (config: GatewayConfig): Promise<Response | null> => {
    const url = new URL(`http://127.0.0.1:${config.port}${pathname}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REST_STATUS_TIMEOUT_MS);
      const res = await fetch(url.toString(), {
        headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res;
    } catch {
      return null;
    }
  };

  let config = loadConfig();
  let res = await attempt(config);

  // On 401, force re-read config (token may have rotated) and retry once
  if (res?.status === 401) {
    cachedConfig = null;
    configLoadedAt = 0;
    config = loadConfig();
    if (config.token) {
      res = await attempt(config);
    }
  }

  if (!res?.ok) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function fetchGatewayReadiness() {
  const ready = await fetchGatewayHttpJson<{ ready?: boolean; failing?: string[] }>('/readyz');
  if (ready && typeof ready.ready === 'boolean') {
    return { ok: ready.ready, failing: ready.failing ?? [] };
  }

  const live = await fetchGatewayHttpJson<{ ok?: boolean; status?: string }>('/healthz');
  if (live && (live.ok === true || live.status === 'live')) {
    return { ok: true, failing: [] as string[] };
  }

  return null;
}

async function fetchGatewaySessionHistory(
  sessionKey: string,
  limit: number,
): Promise<{ sessionKey: string; sessionId?: string; messages?: Array<Record<string, unknown>> } | null> {
  const payload = await fetchGatewayHttpJson<{
    sessionKey?: string;
    items?: Array<Record<string, unknown>>;
    messages?: Array<Record<string, unknown>>;
  }>(`/sessions/${encodeURIComponent(sessionKey)}/history`, {
    limit: String(limit),
  });

  if (!payload) return null;
  return {
    sessionKey: payload.sessionKey ?? sessionKey,
    messages: payload.items ?? payload.messages ?? [],
  };
}

// ── CLI fallback (slow path — 30-40s on modest hardware) ──

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  return trimmed;
}

type CachedStatus = { data: Record<string, unknown>; ts: number };
let statusCache: CachedStatus | null = null;
let refreshPromise: Promise<void> | null = null;
const CACHE_TTL_MS = 15_000;
let statusGeneration = 0;
let gatewayWarmupScheduled = false;
let cliStatusFailureCount = 0;
let cliStatusRetryAfter = 0;
let cliStatusLastErrorLogAt = 0;
let cliBackoffMs = CLI_BACKOFF_BASE_MS;

async function runCliStatusSnapshot(timeoutMs: number): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await execFileAsync(
      'openclaw',
      ['gateway', 'call', 'status', '--json'],
      {
        cwd: process.env.CORTEX_IDE_WORKSPACE_ROOT || process.env.HOME || '/Users/marquisehurtt',
        maxBuffer: 4 * 1024 * 1024,
        timeout: timeoutMs,
        env: {
          ...process.env,
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        },
      },
    );
    return JSON.parse(extractJsonPayload(stdout)) as Record<string, unknown>;
  } catch {
    const { stdout } = await execFileAsync('openclaw', ['status', '--json'], {
      cwd: process.env.CORTEX_IDE_WORKSPACE_ROOT || process.env.HOME || '/Users/marquisehurtt',
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      },
    });
    return JSON.parse(extractJsonPayload(stdout)) as Record<string, unknown>;
  }
}

export function invalidateGatewayStatusCache() {
  statusGeneration += 1;
  statusCache = null;
  refreshPromise = null;
  cliStatusFailureCount = 0;
  cliStatusRetryAfter = 0;
  cliBackoffMs = CLI_BACKOFF_BASE_MS;
  ensureCliRefreshLoop();
}

export function prewarmGatewayStatusCache() {
  ensureCliRefreshLoop();
  void fetchGatewayReadiness().catch(() => null);
  if (!statusCache && !refreshPromise && Date.now() >= cliStatusRetryAfter) {
    void refreshCliCache(CLI_STATUS_TIMEOUT_MS).catch(() => null);
  }
}

function scheduleGatewayStatusWarmup() {
  if (gatewayWarmupScheduled) return;
  gatewayWarmupScheduled = true;
  const timer = setTimeout(() => {
    prewarmGatewayStatusCache();
  }, 0);
  if ('unref' in timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

async function refreshCliCache(timeoutMs = CLI_STATUS_TIMEOUT_MS, force = false): Promise<void> {
  if (!force && Date.now() < cliStatusRetryAfter) {
    return;
  }
  if (!force && refreshPromise) return refreshPromise;

  const generation = statusGeneration;
  refreshPromise = (async () => {
    try {
      const parsed = await runCliStatusSnapshot(timeoutMs);
      if (generation === statusGeneration) {
        statusCache = { data: parsed, ts: Date.now() };
      }
      cliStatusFailureCount = 0;
      cliStatusRetryAfter = 0;
      cliBackoffMs = CLI_BACKOFF_BASE_MS;
    } catch (err) {
      cliStatusFailureCount += 1;
      cliBackoffMs = Math.min(cliBackoffMs * 2, CLI_BACKOFF_MAX_MS);
      cliStatusRetryAfter = Date.now() + cliBackoffMs;

      const now = Date.now();
      if (now - cliStatusLastErrorLogAt >= CLI_STATUS_ERROR_LOG_COOLDOWN_MS || cliStatusFailureCount === 1) {
        const message = (err as Error).message?.slice(0, 120) ?? 'unknown CLI failure';
        console.warn(
          `[gateway-client] CLI cache refresh failed (${cliStatusFailureCount}) — backing off for ${Math.round(cliBackoffMs / 1000)}s: ${message}`
        );
        cliStatusLastErrorLogAt = now;
      }
    } finally {
      refreshPromise = null;
      ensureCliRefreshLoop();
    }
  })();

  return refreshPromise;
}

// Background refresh loop
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTimerDelayMs: number | null = null;

function ensureCliRefreshLoop() {
  if (refreshTimer && refreshTimerDelayMs === cliBackoffMs) return;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  refreshTimerDelayMs = cliBackoffMs;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshTimerDelayMs = null;

    if (Date.now() < cliStatusRetryAfter) {
      ensureCliRefreshLoop();
      return;
    }
    if (statusCache && Date.now() - statusCache.ts < CACHE_TTL_MS) {
      ensureCliRefreshLoop();
      return;
    }

    void refreshCliCache();
  }, cliBackoffMs);
  if (refreshTimer.unref) refreshTimer.unref();
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if ('unref' in timer && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
}

scheduleGatewayStatusWarmup();

// ── Public API ──

/**
 * Get gateway status — sessions + agents.
 * Tries REST API first (<50ms), falls back to CLI cache.
 */
export async function getGatewayStatus(options?: {
  fresh?: boolean;
  maxAgeMs?: number;
}): Promise<{
  gateway: { reachable: boolean; freshness: 'fresh' | 'stale' | 'warming'; source: 'rest' | 'cli' };
  sessions: { recent: Array<Record<string, unknown>> };
  agents: { agents: Array<Record<string, unknown>> };
}> {
  const fresh = options?.fresh ?? false;
  const maxAgeMs = options?.maxAgeMs ?? (fresh ? CLI_FRESH_MAX_AGE_MS : CACHE_TTL_MS);
  const readiness = await fetchGatewayReadiness();
  if (!readiness && !loggedStatusCompatibilityNote) {
    loggedStatusCompatibilityNote = true;
    console.warn(
      '[gateway-client] OpenClaw does not expose the old /api/v1/status route. ' +
      'Using official /readyz + CLI status compatibility mode instead.'
    );
  }

  ensureCliRefreshLoop();

  if (fresh) {
    // Force a new CLI refresh — don't piggyback a pre-mutation inflight request
    await refreshCliCache(CLI_STATUS_TIMEOUT_MS, true);
    const ageMs = statusCache ? Date.now() - statusCache.ts : Infinity;
    if (!statusCache || ageMs > maxAgeMs) {
      throw new Error('Gateway status unavailable — REST is down and a fresh CLI snapshot could not be obtained.');
    }
    const data = statusCache.data as Record<string, unknown>;
    const sessions = data.sessions as { recent?: Array<Record<string, unknown>> } | undefined;
    const agents = data.agents as { agents?: Array<Record<string, unknown>> } | undefined;
    // Report freshness honestly based on actual data age, not request type
    const cliFreshness = ageMs <= CLI_FRESH_MAX_AGE_MS ? 'fresh' : 'stale';
    return {
      gateway: { reachable: readiness?.ok ?? true, freshness: cliFreshness, source: 'cli' },
      sessions: { recent: sessions?.recent ?? [] },
      agents: { agents: agents?.agents ?? [] },
    };
  } else if (statusCache) {
    const ageMs = Date.now() - statusCache.ts;
    if (ageMs >= CACHE_TTL_MS && Date.now() >= cliStatusRetryAfter) {
      void refreshCliCache();
    }
  } else {
    if (Date.now() >= cliStatusRetryAfter) {
      void refreshCliCache();
      await Promise.race([
        refreshPromise ?? Promise.resolve(),
        wait(CLI_COLD_START_WAIT_MS),
      ]);
    }
  }

  if (!statusCache) {
    return {
      gateway: { reachable: readiness?.ok ?? false, freshness: 'warming', source: 'cli' },
      sessions: { recent: [] },
      agents: { agents: [] },
    };
  }

  const data = statusCache.data as Record<string, unknown>;
  const sessions = data.sessions as { recent?: Array<Record<string, unknown>> } | undefined;
  const agents = data.agents as { agents?: Array<Record<string, unknown>> } | undefined;
  const freshness = Date.now() - statusCache.ts <= CLI_FRESH_MAX_AGE_MS ? 'fresh' : 'stale';
  return {
    gateway: { reachable: readiness?.ok ?? true, freshness, source: 'cli' },
    sessions: { recent: sessions?.recent ?? [] },
    agents: { agents: agents?.agents ?? [] },
  };
}

/**
 * Call a gateway RPC method (for chat.history, chat.send, chat.abort).
 * Tries REST API where applicable, falls back to CLI.
 */
/**
 * Save base64 attachment content to disk and return params with file paths
 * in the message text instead of inline base64. This avoids the OS arg-length
 * limit (E2BIG) when passing large payloads through the CLI.
 */
async function saveAttachmentsToDisk(
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const attachments = params.attachments as Array<{
    type?: string; mimeType: string; fileName: string; content: string;
  }> | undefined;

  if (!attachments?.length) return params;

  const mediaDir = join(homedir(), '.openclaw', 'media', 'outbound');
  if (!existsSync(mediaDir)) {
    mkdirSync(mediaDir, { recursive: true });
  }

  const savedPaths: string[] = [];
  for (const att of attachments) {
    if (!att.content) continue;

    // Extract base64 data (handle data: URL prefix)
    let base64 = att.content;
    const dataUrlMatch = base64.match(/^data:[^;]+;base64,(.+)$/);
    if (dataUrlMatch) base64 = dataUrlMatch[1];

    const ext = att.fileName?.match(/\.[^.]+$/)?.[0] || '.png';
    const filename = `${randomUUID()}${ext}`;
    const filePath = join(mediaDir, filename);

    writeFileSync(filePath, Buffer.from(base64, 'base64'));
    savedPaths.push(filePath);
  }

  // Build message with file paths appended
  const message = (params.message as string) || '';
  const mediaLines = savedPaths.map((p) => `[media attached: ${p}]`).join('\n');
  const fullMessage = message ? `${message}\n${mediaLines}` : mediaLines;

  // Return params WITHOUT attachments (they're now files on disk)
  const { attachments: ignoredAttachments, ...rest } = params;
  void ignoredAttachments;
  return { ...rest, message: fullMessage };
}

export async function gatewayRpc<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<T> {
  if (method === 'chat.history') {
    const sessionKey = typeof params.sessionKey === 'string' ? params.sessionKey : '';
    const limit = typeof params.limit === 'number' ? params.limit : 24;
    if (sessionKey) {
      const restResult = await fetchGatewaySessionHistory(sessionKey, limit);
      if (restResult !== null) {
        cliConsecutiveFailures = 0;
        return restResult as T;
      }
    }
  }

  // Strategy 2: CLI fallback with circuit breaker + concurrency limit (#140)
  const paramsJson = JSON.stringify(params);

  // If params are large (e.g. base64 image attachments), save images to
  // disk and replace base64 content with file paths to avoid E2BIG.
  if (paramsJson.length > 100_000 && method === 'chat.send') {
    const slimParams = await saveAttachmentsToDisk(params);
    const slimJson = JSON.stringify(slimParams);
    if (slimJson.length <= 100_000) {
      return gatewayRpc<T>(method, slimParams, timeoutMs);
    }
    return gatewayRpcViaFile<T>(method, slimJson, timeoutMs);
  }
  if (paramsJson.length > 100_000) {
    return gatewayRpcViaFile<T>(method, paramsJson, timeoutMs);
  }

  return gatewayRpcViaCli<T>(method, paramsJson, timeoutMs);
}

/** CLI RPC with concurrency limit and circuit breaker. */
async function gatewayRpcViaCli<T>(
  method: string,
  paramsJson: string,
  timeoutMs: number,
): Promise<T> {
  // Circuit breaker: if open, reject immediately
  if (cliConsecutiveFailures >= CLI_CIRCUIT_BREAKER_THRESHOLD) {
    if (Date.now() < cliCircuitOpenUntil) {
      throw new Error(
        `Gateway CLI circuit breaker open — ${CLI_CIRCUIT_BREAKER_THRESHOLD} consecutive failures. ` +
        `Retrying in ${Math.ceil((cliCircuitOpenUntil - Date.now()) / 1000)}s.`
      );
    }
    // Cooldown expired — allow a probe request through
    cliConsecutiveFailures = CLI_CIRCUIT_BREAKER_THRESHOLD - 1;
  }

  // Concurrency limit: wait for a slot
  if (cliInFlight >= CLI_MAX_CONCURRENT) {
    await wait(200);
    if (cliInFlight >= CLI_MAX_CONCURRENT) {
      throw new Error(`Gateway CLI concurrency limit (${CLI_MAX_CONCURRENT}) reached — try again shortly.`);
    }
  }

  cliInFlight++;
  try {
    const { stdout } = await execFileAsync(
      'openclaw',
      ['gateway', 'call', method, '--json', '--params', paramsJson],
      {
        cwd: process.env.CORTEX_IDE_WORKSPACE_ROOT || process.env.HOME || '/Users/marquisehurtt',
        maxBuffer: 10 * 1024 * 1024,
        timeout: timeoutMs,
        env: {
          ...process.env,
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        },
      },
    );

    cliConsecutiveFailures = 0;
    return JSON.parse(extractJsonPayload(stdout)) as T;
  } catch (err) {
    cliConsecutiveFailures++;
    if (cliConsecutiveFailures >= CLI_CIRCUIT_BREAKER_THRESHOLD) {
      cliCircuitOpenUntil = Date.now() + CLI_CIRCUIT_BREAKER_COOLDOWN_MS;
      console.warn(
        `[gateway-client] CLI circuit breaker tripped after ${CLI_CIRCUIT_BREAKER_THRESHOLD} failures — ` +
        `pausing CLI calls for ${CLI_CIRCUIT_BREAKER_COOLDOWN_MS / 1000}s.`
      );
    }
    throw err;
  } finally {
    cliInFlight--;
  }
}

/**
 * Large-payload RPC via stdin — spawns a small Node script that reads
 * JSON params from stdin and passes them to `openclaw gateway call`.
 * Bypasses the OS arg-length limit (E2BIG) for base64 image payloads.
 */
async function gatewayRpcViaFile<T>(
  method: string,
  paramsJson: string,
  timeoutMs: number,
): Promise<T> {
  // Inline script: reads all of stdin, then calls openclaw with --params
  const inlineScript = `
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => {
      const params = Buffer.concat(chunks).toString();
      const { execFileSync } = require('child_process');
      try {
        const out = execFileSync('openclaw',
          ['gateway', 'call', '${method}', '--json', '--params', params],
          { maxBuffer: 10*1024*1024, timeout: ${timeoutMs}, env: process.env }
        );
        process.stdout.write(out);
      } catch(e) {
        process.stderr.write(e.message || 'RPC failed');
        process.exit(1);
      }
    });
  `;

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('gatewayRpcViaFile timeout')), timeoutMs + 5000);

    const child = spawn(process.execPath, ['-e', inlineScript], {
      cwd: process.env.CORTEX_IDE_WORKSPACE_ROOT || process.env.HOME || '/Users/marquisehurtt',
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString();
      const stderr = Buffer.concat(stderrChunks).toString();

      if (code !== 0) {
        reject(new Error(`RPC child exited ${code}: ${stderr.slice(0, 200)}`));
        return;
      }

      try {
        resolve(JSON.parse(extractJsonPayload(stdout)) as T);
      } catch {
        reject(new Error(`Failed to parse RPC response: ${stdout.slice(0, 200)}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Write params to stdin and close
    child.stdin.write(paramsJson);
    child.stdin.end();
  });
}
