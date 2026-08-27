import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ensureRoleRoutingLedgerSchema,
  listRoleRoutingReceipts,
  recordRoleRoutingReceipt,
} from './role-routing-ledger';

const tempPaths: string[] = [];

afterEach(() => {
  for (const path of tempPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function route(label: string) {
  return {
    backend: null,
    runtime: 'codex' as const,
    model: 'gpt-5.6-terra',
    effort: 'high' as const,
    label,
  };
}

const sources = {
  backend: 'derived' as const,
  runtime: 'file' as const,
  model: 'runtime-default' as const,
  effort: 'file' as const,
};

describe('role routing ledger', () => {
  it('keeps requested and effective routing readable after a database reopen', () => {
    const root = mkdtempSync(join(tmpdir(), 'o8-role-routing-ledger-'));
    tempPaths.push(root);
    const dbPath = join(root, 'ledger.db');
    const first = new Database(dbPath);
    try {
      recordRoleRoutingReceipt({
        receiptKey: 'packet:pkt-1:attempt-1',
        role: 'build',
        repoPath: '/repo/o8',
        contextType: 'packet',
        contextId: 'pkt-1',
        requested: { ...route('Requested'), model: null },
        effective: route('Effective'),
        sources,
        reason: 'The runtime supplied its default model.',
        fallbackReason: null,
        status: 'selected',
        createdAt: '2026-08-27T20:00:00.000Z',
      }, first);
    } finally {
      first.close();
    }

    const reopened = new Database(dbPath);
    try {
      const [receipt] = listRoleRoutingReceipts({ role: 'build' }, reopened);
      expect(receipt).toMatchObject({
        receiptKey: 'packet:pkt-1:attempt-1',
        role: 'build',
        requested: { model: null },
        effective: { runtime: 'codex', model: 'gpt-5.6-terra' },
        status: 'selected',
      });
    } finally {
      reopened.close();
    }
  });

  it('updates one idempotent receipt instead of duplicating a retried command', () => {
    const sqlite = new Database(':memory:');
    try {
      ensureRoleRoutingLedgerSchema(sqlite);
      const input = {
        receiptKey: 'review:turn-1',
        role: 'review' as const,
        requested: route('Requested'),
        effective: route('Effective'),
        sources,
        reason: 'Initial reviewer selected.',
        status: 'selected' as const,
      };
      recordRoleRoutingReceipt(input, sqlite);
      recordRoleRoutingReceipt({
        ...input,
        reason: 'Fallback reviewer completed.',
        fallbackReason: 'The requested reviewer exhausted its quota.',
        status: 'fallback',
      }, sqlite);

      const receipts = listRoleRoutingReceipts({}, sqlite);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({
        reason: 'Fallback reviewer completed.',
        fallbackReason: 'The requested reviewer exhausted its quota.',
        status: 'fallback',
      });
    } finally {
      sqlite.close();
    }
  });
});
