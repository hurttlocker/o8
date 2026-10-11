import 'server-only';

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import { cliInvocation } from '@/lib/runtimes/shared/cli-spawn';
import { forceKillTreeWindows } from '@/lib/runtimes/shared/owned-session/helpers';
import { resolveClaudeBinary } from '@/lib/runtimes/shared/cli-locate';
import type { RuntimeCapacityBucket, RuntimeCapacitySnapshot } from '@/lib/runtimes/types';
import { readClaudeRuntimeCapacity } from '@/lib/usage/cli-scrape';

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

export function parseClaudeUsageCapacity(value: unknown, observedAt = Date.now()): RuntimeCapacitySnapshot {
  const response = record(value);
  const limits = record(response?.rate_limits);
  const buckets: RuntimeCapacityBucket[] = [];
  const add = (id: string, label: string, raw: unknown) => {
    const window = record(raw);
    if (window?.utilization == null) return;
    if (typeof window.utilization !== 'number' || !Number.isFinite(window.utilization) || window.utilization < 0 || window.utilization > 100) {
      throw new Error('Malformed Claude usage window');
    }
    const reset = typeof window.resets_at === 'string' ? Date.parse(window.resets_at) : NaN;
    buckets.push({ id, label, usedRatio: window.utilization / 100, used: null, unit: null, remaining: null,
      resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null, expiresAt: null });
  };
  if (response?.rate_limits_available === true && limits) {
    add('five_hour', '5-hour', limits.five_hour);
    add('seven_day', 'Weekly', limits.seven_day);
    add('seven_day_oauth_apps', 'Weekly · apps', limits.seven_day_oauth_apps);
    add('seven_day_opus', 'Weekly · Opus', limits.seven_day_opus);
    add('seven_day_sonnet', 'Weekly · Sonnet', limits.seven_day_sonnet);
    if (Array.isArray(limits.model_scoped)) {
      for (const raw of limits.model_scoped.slice(0, 24)) {
        const scoped = record(raw);
        if (typeof scoped?.display_name !== 'string' || !scoped.display_name.trim()) continue;
        const label = scoped.display_name.trim().slice(0, 80);
        add(`model:${label}`, `Weekly · ${label}`, scoped);
      }
    }
  }
  return { runtime: 'claude-code', identityId: null, status: buckets.length ? 'available' : 'unavailable',
    reason: buckets.length ? null : response?.rate_limits_available === false ? 'subscription_limits_unsupported' : 'quota_not_reported',
    observedAt: new Date(observedAt).toISOString(), source: 'structured-cli', confidence: buckets.length ? 'exact' : null,
    buckets: [...new Map(buckets.map(bucket => [bucket.id, bucket])).values()] };
}

/** Initialize the CLI and request usage only. Never send a user message or open a worker session. */
export async function readLiveClaudeRuntimeCapacity(options: {
  binaryPath?: string; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv;
} = {}): Promise<RuntimeCapacitySnapshot> {
  const invocation = cliInvocation(options.binaryPath ?? resolveClaudeBinary(), [
    '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--no-session-persistence', '--setting-sources', 'user', '--settings', '{"disableAllHooks":true}',
    '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  ]);
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_AUTO_CONNECT_IDE: '0', CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1' };
    delete env.FORCE_CODE_TERMINAL;
    const proc = spawn(invocation.command, invocation.args, {
      cwd: options.cwd ?? homedir(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const initId = randomUUID();
    const usageId = randomUUID();
    let buffer = '';
    const decoder = new StringDecoder('utf8');
    let bytes = 0;
    let settled = false;
    let requestedUsage = false;
    const finish = (value?: RuntimeCapacitySnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      proc.stdin.end();
      if (process.platform === 'win32' && proc.pid) void forceKillTreeWindows(proc.pid);
      else proc.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 500);
      killTimer.unref();
      proc.once('close', () => clearTimeout(killTimer));
      if (value) resolve(value); else reject(new Error('Claude usage observation unavailable'));
    };
    const send = (requestId: string, request: RecordValue) => {
      proc.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: requestId, request })}\n`);
    };
    const timeout = setTimeout(() => finish(), options.timeoutMs ?? 6_500);
    proc.on('error', () => finish());
    proc.stdin.on('error', () => finish());
    proc.on('close', () => finish());
    proc.stderr.resume(); // Never expose CLI banners, account fields, or raw errors to the client.
    proc.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_048_576) { finish(); return; }
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        let row: RecordValue | null;
        try { row = record(JSON.parse(line)); } catch { continue; }
        if (row?.type !== 'control_response') continue;
        const response = record(row.response);
        if (response?.request_id !== initId && response?.request_id !== usageId) continue;
        if (response.subtype !== 'success') { finish(); return; }
        if (response.request_id === initId && !requestedUsage) {
          requestedUsage = true;
          send(usageId, { subtype: 'get_usage', skip_behaviors: true });
        } else if (response.request_id === usageId && requestedUsage) {
          try { finish(parseClaudeUsageCapacity(response.response)); } catch { finish(); }
        }
      }
    });
    send(initId, { subtype: 'initialize', hooks: {} });
  });
}

const CACHE_MS = 60_000;
let lastAttempt = 0;
let lastGood: RuntimeCapacitySnapshot | null = null;
let latest: RuntimeCapacitySnapshot | null = null;
let inflight: Promise<RuntimeCapacitySnapshot> | null = null;

export async function readClaudeAccountCapacity(options: { fresh?: boolean } = {}): Promise<RuntimeCapacitySnapshot> {
  if (inflight) return inflight;
  if (!options.fresh && latest && Date.now() - lastAttempt < CACHE_MS) return latest;
  inflight = (async () => {
    let observed: RuntimeCapacitySnapshot | null = null;
    try { observed = await readLiveClaudeRuntimeCapacity(); } catch { /* Retain a prior observation or local activity. */ }
    if (observed?.status === 'available') lastGood = observed;
    if (observed?.reason === 'subscription_limits_unsupported') lastGood = null;
    const fallback = observed?.reason === 'subscription_limits_unsupported' ? observed : readClaudeRuntimeCapacity();
    latest = observed?.status === 'available' ? observed : lastGood
      ? { ...lastGood, status: 'stale', reason: 'quota_refresh_failed' }
      : fallback.buckets.length ? { ...fallback, reason: 'quota_not_reported' }
        : observed ?? { ...fallback, reason: 'quota_not_reported' };
    lastAttempt = Date.now();
    return latest;
  })().finally(() => { inflight = null; });
  return inflight;
}

export function resetClaudeCapacityForTests(): void {
  lastAttempt = 0; lastGood = null; latest = null; inflight = null;
}
