import { describe, expect, it } from 'vitest';

import { prependOwnedRun } from './run-ledger';
import type { OwnedRunRecord, OwnedSessionRecord } from './types';

function session(runIdentityLedger: OwnedSessionRecord['runIdentityLedger']): OwnedSessionRecord {
  return {
    surfaceId: 'ledger-owned:session',
    sessionDir: '/tmp/ledger-session',
    cwd: '/tmp/repo',
    repoPath: '/tmp/repo',
    title: 'ledger test',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    latestPrompt: '',
    latestSummary: '',
    recentRuns: [],
    runIdentityLedger,
  };
}

function run(index: number): OwnedRunRecord {
  return {
    id: `run-${index}`,
    mode: 'launch',
    prompt: '',
    startedAt: '2026-08-15T00:00:00.000Z',
    pid: 4_000 + index,
    processGroupId: 4_000 + index,
    processMarker: `marker-${index}`,
    stdoutPath: `/tmp/run-${index}.jsonl`,
    stderrPath: `/tmp/run-${index}.stderr.log`,
    outcome: 'finished',
  };
}

describe('owned run identity ledger', () => {
  it('permanently records truncation when run seventeen rolls the bounded ledger', () => {
    const record = session({ version: 1, totalRuns: 0, complete: true });
    for (let index = 1; index <= 17; index += 1) prependOwnedRun(record, run(index));

    expect(record.recentRuns).toHaveLength(16);
    expect(record.recentRuns.map((entry) => entry.id)).toEqual([
      'run-17', 'run-16', 'run-15', 'run-14', 'run-13', 'run-12', 'run-11', 'run-10',
      'run-9', 'run-8', 'run-7', 'run-6', 'run-5', 'run-4', 'run-3', 'run-2',
    ]);
    expect(record.runIdentityLedger).toEqual({ version: 1, totalRuns: 17, complete: false });

    prependOwnedRun(record, run(18));
    expect(record.runIdentityLedger).toEqual({ version: 1, totalRuns: 18, complete: false });
  });

  it('keeps legacy total-run truth unknown instead of upgrading it', () => {
    const record = session(undefined);
    prependOwnedRun(record, run(1));
    expect(record.runIdentityLedger).toEqual({ version: 1, totalRuns: null, complete: false });
  });
});
