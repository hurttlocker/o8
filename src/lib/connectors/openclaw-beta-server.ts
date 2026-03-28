import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { OpenClawIntegrationStatus } from '@/lib/connectors/openclaw-beta';

const CORTEX_BIN = process.env.CORTEX_BINARY || join(process.env.HOME || homedir(), 'bin', 'cortex');
const OPENCLAW_STATUS_TTL_MS = 5000;

let cachedStatus: { status: OpenClawIntegrationStatus; timestamp: number } | null = null;

function fallbackStatus(error?: string): OpenClawIntegrationStatus {
  return {
    integration: 'openclaw',
    mode: 'disabled',
    effective_enabled: false,
    configured: cachedStatus?.status.configured ?? false,
    config_path: cachedStatus?.status.config_path,
    source: cachedStatus?.status.source,
    from: cachedStatus?.status.from,
    error,
  };
}

function normalizeServerStatus(raw: unknown): OpenClawIntegrationStatus {
  const object = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const mode = object.mode === 'enabled' || object.mode === 'disabled' || object.mode === 'auto'
    ? object.mode
    : 'disabled';
  const explicitEnabled = mode === 'enabled';

  return {
    integration: 'openclaw',
    mode,
    effective_enabled: typeof object.effective_enabled === 'boolean'
      ? (explicitEnabled ? object.effective_enabled : false)
      : explicitEnabled,
    configured: object.configured !== false,
    config_path: typeof object.config_path === 'string' ? object.config_path : undefined,
    source: typeof object.source === 'string' ? object.source : undefined,
    from: typeof object.from === 'string' ? object.from : undefined,
    error: typeof object.error === 'string' ? object.error : undefined,
  };
}

export function getServerOpenClawBetaStatus(options: { fresh?: boolean } = {}): OpenClawIntegrationStatus {
  const fresh = options.fresh ?? false;

  if (!fresh && cachedStatus && Date.now() - cachedStatus.timestamp < OPENCLAW_STATUS_TTL_MS) {
    return cachedStatus.status;
  }

  const result = spawnSync(CORTEX_BIN, ['integration', 'openclaw', '--json'], {
    encoding: 'utf-8',
    timeout: 30_000,
  });

  if (result.error) {
    return cachedStatus?.status ?? fallbackStatus(result.error.message || String(result.error));
  }

  const stdout = (result.stdout || '').trim();
  const stderr = (result.stderr || '').trim();
  const output = stdout || stderr;

  if (result.status !== 0) {
    return cachedStatus?.status ?? fallbackStatus(output || `Command failed with exit code ${result.status}`);
  }

  let parsed: unknown = {};
  try {
    parsed = output ? JSON.parse(output) : {};
  } catch {
    parsed = {};
  }

  const status = normalizeServerStatus(parsed);
  cachedStatus = { status, timestamp: Date.now() };
  return status;
}

export function getServerOpenClawBetaEnabled(options: { fresh?: boolean } = {}) {
  return getServerOpenClawBetaStatus(options).effective_enabled;
}
