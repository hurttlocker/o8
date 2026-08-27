import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  startStorageAdmissionReconciliation,
  STORAGE_ADMISSION_RECONCILIATION_INTERVAL_MS,
  type StorageAdmissionLedgerReconciliationResult,
} from './storage-admission-reconciliation';

function result(): StorageAdmissionLedgerReconciliationResult {
  return {
    expired: {
      inspected: 0,
      reconciled: 0,
      retainedLive: 0,
      retainedUnknown: 0,
      held: 0,
    },
    committed: {
      inspected: 1,
      released: 1,
      releasedBytes: 2_000,
      retainedLive: 0,
      retainedUnknown: 0,
      held: 0,
    },
  };
}

describe('storage admission runtime reconciliation', () => {
  it('is started by the real WebSocket runtime bootstrap', () => {
    const source = readFileSync(path.join(process.cwd(), 'src/ws-server.ts'), 'utf8');
    expect(source).toContain('startStorageAdmissionReconciliation({');
    expect(source).toContain('await reconciliation.initial');
  });

  it('runs at startup and on the recurring runtime interval', async () => {
    const reconcile = vi.fn(async () => result());
    let tick: (() => void) | null = null;
    const unref = vi.fn();
    const schedule = vi.fn((callback: () => void, intervalMs: number) => {
      tick = callback;
      expect(intervalMs).toBe(STORAGE_ADMISSION_RECONCILIATION_INTERVAL_MS);
      return { unref };
    });
    const periodic = vi.fn();
    const started = startStorageAdmissionReconciliation({
      reconcile,
      schedule,
      onPeriodicResult: periodic,
    });

    await expect(started.initial).resolves.toEqual(result());
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(schedule).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);

    tick!();
    await vi.waitFor(() => expect(periodic).toHaveBeenCalledWith(result()));
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});
