import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

export type PersistentTerminalHealthStatus = 'unverified' | 'ready' | 'degraded' | 'disabled';
export type PersistentTerminalHealthReason =
  | 'no_runtime_receipt'
  | 'operator_disabled'
  | 'tmux_unavailable'
  | 'session_created'
  | 'session_reused'
  | 'session_create_failed';

export interface PersistentTerminalHealth {
  schema: 'o8/persistent-terminal-health/v1';
  status: PersistentTerminalHealthStatus;
  reason: PersistentTerminalHealthReason;
  checkedAt: string;
}

const SCHEMA = 'o8/persistent-terminal-health/v1' as const;
const FILE_NAME = 'persistent-terminal-health.json';
const STATUSES = new Set<PersistentTerminalHealthStatus>(['unverified', 'ready', 'degraded', 'disabled']);
const REASONS = new Set<PersistentTerminalHealthReason>([
  'no_runtime_receipt',
  'operator_disabled',
  'tmux_unavailable',
  'session_created',
  'session_reused',
  'session_create_failed',
]);

function healthPath() {
  return join(getDataDir(), FILE_NAME);
}

export function recordPersistentTerminalHealth(
  status: Exclude<PersistentTerminalHealthStatus, 'unverified'>,
  reason: Exclude<PersistentTerminalHealthReason, 'no_runtime_receipt'>,
): PersistentTerminalHealth {
  const receipt: PersistentTerminalHealth = {
    schema: SCHEMA,
    status,
    reason,
    checkedAt: new Date().toISOString(),
  };
  const target = healthPath();
  const temporary = `${target}.${process.pid}.tmp`;
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, target);
  return receipt;
}

export function readPersistentTerminalHealth(): PersistentTerminalHealth | null {
  try {
    const parsed = JSON.parse(readFileSync(healthPath(), 'utf8')) as Partial<PersistentTerminalHealth>;
    if (parsed.schema !== SCHEMA || !STATUSES.has(parsed.status as PersistentTerminalHealthStatus)) return null;
    if (!REASONS.has(parsed.reason as PersistentTerminalHealthReason)) return null;
    if (typeof parsed.checkedAt !== 'string' || !parsed.checkedAt.trim()) return null;
    return parsed as PersistentTerminalHealth;
  } catch {
    return null;
  }
}

export function currentPersistentTerminalHealth(configured: boolean): PersistentTerminalHealth {
  const recorded = readPersistentTerminalHealth();
  if (!configured) {
    return recorded?.status === 'disabled'
      ? recorded
      : { schema: SCHEMA, status: 'disabled', reason: 'operator_disabled', checkedAt: new Date(0).toISOString() };
  }
  if (!recorded || recorded.status === 'disabled') {
    return { schema: SCHEMA, status: 'unverified', reason: 'no_runtime_receipt', checkedAt: new Date(0).toISOString() };
  }
  return recorded;
}
