import 'server-only';

import { getSqlite } from '@/lib/db';

const HALT_KEY = 'orchestrator_dispatch_halt';

export interface DispatchHaltState {
  halted: boolean;
  reason: string | null;
  updatedAt: number | null;
}

interface DispatchHaltRow {
  value: string;
  updated_at: number;
}

function parseHaltValue(value: string, updatedAt: number): DispatchHaltState {
  try {
    const parsed = JSON.parse(value) as Partial<DispatchHaltState>;
    return {
      halted: parsed.halted === true,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : null,
      updatedAt,
    };
  } catch {
    return { halted: value === '1', reason: null, updatedAt };
  }
}

export function readDispatchHaltState(): DispatchHaltState {
  const row = getSqlite().prepare(
    'SELECT value, updated_at FROM app_state WHERE key = ? LIMIT 1',
  ).get(HALT_KEY) as DispatchHaltRow | undefined;
  if (!row) return { halted: false, reason: null, updatedAt: null };
  return parseHaltValue(row.value, row.updated_at);
}

export function isDispatchHalted(): boolean {
  return readDispatchHaltState().halted;
}

export function setDispatchHaltState(halted: boolean, reason?: string | null): DispatchHaltState {
  const now = Date.now();
  const next: DispatchHaltState = {
    halted,
    reason: halted && reason?.trim() ? reason.trim() : null,
    updatedAt: now,
  };
  getSqlite().prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(HALT_KEY, JSON.stringify(next), now);
  return next;
}
