/**
 * Gateway client — fetches agent/session data from the OpenClaw gateway.
 *
 * Strategy (resilient to OpenClaw version changes):
 *   1. Try HTTP REST API first (/api/v1/status) — <50ms, available on OC 2026.3.14+
 *   2. Fall back to CLI cache (`openclaw status --json`) for older versions
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

function loadConfig(): GatewayConfig {
  if (cachedConfig) return cachedConfig;
  try {
    const home = process.env.HOME || '/Users/marquisehurtt';
    const raw = readFileSync(join(home, '.openclaw', 'openclaw.json'), 'utf-8');
    const config = JSON.parse(raw);
    cachedConfig = {
      port: config?.gateway?.port ?? 18789,
      token: config?.gateway?.auth?.token ?? '',
    };
  } catch {
    cachedConfig = { port: 18789, token: '' };
  }
  return cachedConfig;
}

// ── REST API (primary — fast path) ──

async function fetchRestApi<T>(endpoint: string, params?: Record<string, string>): Promise<T | null> {
  const config = loadConfig();
  const url = new URL(`http://127.0.0.1:${config.port}/api/v1/${endpoint}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);

    const res = await fetch(url.toString(), {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
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
let refreshing = false;
const CACHE_TTL_MS = 30_000;

async function refreshCliCache(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const { stdout } = await execFileAsync('openclaw', ['status', '--json'], {
      cwd: process.env.CORTEX_IDE_WORKSPACE_ROOT || process.env.HOME || '/Users/marquisehurtt',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 45_000,
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      },
    });
    const parsed = JSON.parse(extractJsonPayload(stdout));
    statusCache = { data: parsed, ts: Date.now() };
  } catch (err) {
    console.error('[gateway-client] CLI cache refresh failed:', (err as Error).message?.slice(0, 80));
  } finally {
    refreshing = false;
  }
}

// Background refresh loop
let refreshInterval: ReturnType<typeof setInterval> | null = null;
function ensureCliRefreshLoop() {
  if (refreshInterval) return;
  refreshInterval = setInterval(() => {
    if (statusCache && Date.now() - statusCache.ts < CACHE_TTL_MS) return;
    refreshCliCache();
  }, CACHE_TTL_MS);
  if (refreshInterval.unref) refreshInterval.unref();
}

// ── Public API ──

/**
 * Get gateway status — sessions + agents.
 * Tries REST API first (<50ms), falls back to CLI cache.
 */
export async function getGatewayStatus(): Promise<{
  gateway: { reachable: boolean };
  sessions: { recent: Array<Record<string, unknown>> };
  agents: { agents: Array<Record<string, unknown>> };
}> {
  // Strategy 1: REST API (fast path)
  const restResult = await fetchRestApi<{
    ts: number;
    sessions: { count?: number; sessions?: Array<Record<string, unknown>> };
    agents: { agents?: Array<Record<string, unknown>> };
  }>('status', { activeMinutes: '10080' });

  if (restResult?.sessions) {
    return {
      gateway: { reachable: true },
      sessions: { recent: restResult.sessions.sessions ?? [] },
      agents: { agents: restResult.agents?.agents ?? [] },
    };
  }

  // Strategy 2: CLI cache (slow fallback)
  console.warn(
    '[gateway-client] ⚠️ REST API unavailable — falling back to CLI cache (30-40s).\n' +
    '  Fix: run ~/cortex-ide/scripts/rest-api-patch.sh\n' +
    '  PR: https://github.com/openclaw/openclaw/pull/47863'
  );
  ensureCliRefreshLoop();

  if (!statusCache) {
    await refreshCliCache();
  }

  if (!statusCache) {
    throw new Error('Gateway status unavailable (both REST and CLI failed)');
  }

  const data = statusCache.data as Record<string, unknown>;
  return {
    gateway: { reachable: true },
    sessions: { recent: (data.sessions as any)?.recent ?? [] },
    agents: { agents: (data.agents as any)?.agents ?? [] },
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
  const { attachments: _, ...rest } = params;
  return { ...rest, message: fullMessage };
}

export async function gatewayRpc<T>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<T> {
  const paramsJson = JSON.stringify(params);

  // If params are large (e.g. base64 image attachments), save images to
  // disk and replace base64 content with file paths to avoid E2BIG.
  if (paramsJson.length > 100_000 && method === 'chat.send') {
    const slimParams = await saveAttachmentsToDisk(params);
    const slimJson = JSON.stringify(slimParams);
    if (slimJson.length <= 100_000) {
      return gatewayRpc<T>(method, slimParams, timeoutMs);
    }
    // Still too large — fall through to file-based approach
    return gatewayRpcViaFile<T>(method, slimJson, timeoutMs);
  }
  if (paramsJson.length > 100_000) {
    return gatewayRpcViaFile<T>(method, paramsJson, timeoutMs);
  }

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

  return JSON.parse(extractJsonPayload(stdout)) as T;
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
