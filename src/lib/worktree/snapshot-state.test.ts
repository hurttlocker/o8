import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-workspace-snapshots-'));
const dbPath = join(dataDir, 'cortex-ide.db');

// Simulate an install that last opened on v36. The first store access must
// add v37 without replacing the existing database.
const legacy = new Database(dbPath);
legacy.exec('CREATE TABLE pre_v37_receipt (value TEXT NOT NULL)');
legacy.prepare('INSERT INTO pre_v37_receipt (value) VALUES (?)').run('preserve-me');
legacy.close();
writeFileSync(join(dataDir, '.db-migrated-v36'), 'legacy marker');
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const {
  WorkspaceSnapshotCorruptError,
  WorkspaceSnapshotInputError,
  WorkspaceSnapshotTransitionReuseError,
  countWorkspaceSnapshotsByState,
  createWorkspaceSnapshot,
  getWorkspaceSnapshot,
  listWorkspaceSnapshotsForReconciliation,
  scanWorkspaceSnapshotsForReconciliation,
  listWorkspaceSnapshotTransitions,
  transitionWorkspaceSnapshot,
} = await import('./snapshot-state');
const { beginWorkspaceSnapshotGeneration } = await import('./snapshot-generation');
const { closeDb, getDb, getSqlite } = await import('@/lib/db');

let sequence = 0;

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableJson(record[key])]));
  }
  return value;
}

function fingerprintForRecord(record: ReturnType<typeof getWorkspaceSnapshot> & object, headCommit: string): string {
  const truth = {
    repositoryUuid: record.repositoryUuid,
    packetId: record.packetId,
    missionId: record.missionId,
    laneId: record.laneId,
    originalPath: record.originalPath,
    branch: record.branch,
    baseCommit: record.baseCommit,
    headCommit,
    treeSha: record.treeSha,
    recoveryRef: record.recoveryRef,
    diffFingerprint: record.diffFingerprint,
    dependencyRecipeKey: record.dependencyRecipeKey,
    sessionIdentities: record.sessionIdentities,
    reservation: record.reservation,
  };
  return createHash('sha256').update(JSON.stringify(stableJson(truth))).digest('hex');
}

function snapshotInput(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return {
    repositoryUuid: `repo-uuid-${sequence}`,
    packetId: `packet-${sequence}`,
    missionId: `mission-${sequence}`,
    laneId: `lane-${sequence}`,
    originalPath: `/tmp/o8-packet-${sequence}`,
    branch: `inline/packet-${sequence}`,
    baseCommit: `base-${sequence}`,
    headCommit: `head-${sequence}`,
    treeSha: `tree-${sequence}`,
    recoveryRef: `refs/o8/recovery/packet-${sequence}`,
    diffFingerprint: `diff-${sequence}`,
    dependencyRecipeKey: `deps-${sequence}`,
    sessionIdentities: [
      {
        kind: 'worker',
        identity: `session-${sequence}`,
        runtime: 'codex',
        bindingId: `binding-${sequence}`,
      },
      { kind: 'transcript', identity: `transcript-${sequence}` },
    ],
    reservation: {
      id: `reservation-${sequence}`,
      bytes: 4096,
      volumeId: 'volume-main',
      reservedAt: 1000 + sequence,
    },
    creationId: `create-${sequence}`,
    transitionStartedAt: 2000 + sequence,
    recordedAt: 3000 + sequence,
    receipt: { source: 'snapshot-boundary' },
    ...overrides,
  };
}

function moveToHibernating(
  repositoryUuid: string,
  packetId: string,
  version = 1,
  prefix = `${repositoryUuid}-${packetId}`,
) {
  const parkable = transitionWorkspaceSnapshot({
    repositoryUuid,
    packetId,
    transitionId: `${prefix}-parkable`,
    expectedState: 'materialized',
    expectedVersion: version,
    toState: 'parkable',
    transitionStartedAt: 4000,
    recordedAt: 4001,
  });
  expect(parkable.status).toBe('applied');
  const hibernating = transitionWorkspaceSnapshot({
    repositoryUuid,
    packetId,
    transitionId: `${prefix}-hibernating`,
    expectedState: 'parkable',
    expectedVersion: version + 1,
    toState: 'hibernating',
    transitionStartedAt: 4002,
    recordedAt: 4003,
    receipt: { recoveryRefReadable: true },
  });
  expect(hibernating.status).toBe('applied');
  if (hibernating.status !== 'applied') {
    throw new Error(`Expected hibernating transition to apply, received ${hibernating.status}.`);
  }
  return hibernating.record;
}

describe('workspace snapshot persistence', () => {
  it('projects parked workspace counts from durable snapshot state', () => {
    const parkedBefore = countWorkspaceSnapshotsByState('parked');
    const input = snapshotInput();
    createWorkspaceSnapshot(input);
    const hibernating = moveToHibernating(input.repositoryUuid, input.packetId);
    const parked = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: `${input.packetId}-parked`,
      expectedState: 'hibernating',
      expectedVersion: hibernating.version,
      toState: 'parked',
      transitionStartedAt: 4004,
      recordedAt: 4005,
    });

    expect(parked.status).toBe('applied');
    expect(countWorkspaceSnapshotsByState('parked')).toBe(parkedBefore + 1);
  });

  it('upgrades a v36 database and persists the full registry-UUID snapshot truth', () => {
    const input = snapshotInput();
    const created = createWorkspaceSnapshot(input);

    expect(created.status).toBe('created');
    expect(created.record).toMatchObject({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      missionId: input.missionId,
      laneId: input.laneId,
      originalPath: input.originalPath,
      branch: input.branch,
      baseCommit: input.baseCommit,
      headCommit: input.headCommit,
      treeSha: input.treeSha,
      recoveryRef: input.recoveryRef,
      diffFingerprint: input.diffFingerprint,
      dependencyRecipeKey: input.dependencyRecipeKey,
      sessionIdentities: input.sessionIdentities,
      reservation: input.reservation,
      state: 'materialized',
      version: 1,
      snapshotGeneration: 1,
    });
    expect(getWorkspaceSnapshot(input.repositoryUuid, input.packetId)).toEqual(created.record);
    expect(createWorkspaceSnapshot(input)).toEqual({ status: 'idempotent', record: created.record });
    expect(createWorkspaceSnapshot({ ...input, creationId: 'another-create-id' }).status).toBe('conflict');
    expect(() => createWorkspaceSnapshot({
      ...input,
      receipt: { source: 'different-boundary' },
    })).toThrow(WorkspaceSnapshotTransitionReuseError);
    expect(getSqlite().prepare('SELECT value FROM pre_v37_receipt').pluck().get()).toBe('preserve-me');
    expect(existsSync(join(dataDir, '.db-migrated-v37'))).toBe(true);
  });

  it('keys identity by repository UUID and packet ID instead of path', () => {
    const first = snapshotInput({
      repositoryUuid: 'repo-a',
      packetId: 'shared-packet',
      originalPath: '/old/location/repo-a-packet',
      creationId: 'create-repo-a',
    });
    const second = snapshotInput({
      repositoryUuid: 'repo-b',
      packetId: 'shared-packet',
      originalPath: '/new/location/repo-b-packet',
      creationId: 'create-repo-b',
    });
    expect(createWorkspaceSnapshot(first).status).toBe('created');
    expect(createWorkspaceSnapshot(second).status).toBe('created');
    expect(getWorkspaceSnapshot('repo-a', 'shared-packet')?.originalPath).toBe('/old/location/repo-a-packet');
    expect(getWorkspaceSnapshot('repo-b', 'shared-packet')?.originalPath).toBe('/new/location/repo-b-packet');
  });

  it.each([
    ['original path', 'original_path', '/tmp/tampered-workspace'],
    ['head commit', 'head_commit', 'tampered-head'],
    ['tree SHA', 'tree_sha', 'tampered-tree'],
    ['recovery ref', 'recovery_ref', 'refs/o8/recovery/tampered'],
    ['session identity JSON', 'session_identity_json', '[{"kind":"worker","identity":"tampered-session"}]'],
    ['invalid session identity JSON', 'session_identity_json', '{invalid-json'],
  ])('rejects persisted %s corruption on reads and idempotent creation replay', (_label, column, value) => {
    const input = snapshotInput();
    createWorkspaceSnapshot(input);
    getSqlite().prepare(`
      UPDATE workspace_snapshots SET ${column} = ?
      WHERE repository_uuid = ? AND packet_id = ?
    `).run(value, input.repositoryUuid, input.packetId);

    expect(() => getWorkspaceSnapshot(input.repositoryUuid, input.packetId))
      .toThrow(WorkspaceSnapshotCorruptError);
    expect(() => createWorkspaceSnapshot(input)).toThrow(WorkspaceSnapshotCorruptError);
  });

  it('rejects a forged row fingerprint that no longer matches the immutable creation receipt', () => {
    const input = snapshotInput();
    const created = createWorkspaceSnapshot(input);
    const forgedHead = 'forged-head-with-matching-row-fingerprint';
    const forgedFingerprint = fingerprintForRecord(created.record, forgedHead);
    getSqlite().prepare(`
      UPDATE workspace_snapshots SET head_commit = ?, snapshot_fingerprint = ?
      WHERE repository_uuid = ? AND packet_id = ?
    `).run(forgedHead, forgedFingerprint, input.repositoryUuid, input.packetId);

    expect(() => getWorkspaceSnapshot(input.repositoryUuid, input.packetId))
      .toThrow(/immutable creation receipt/);
  });

  it('quarantines one corrupt reconciliation row without hiding healthy workspaces', () => {
    const corrupt = snapshotInput();
    const healthy = snapshotInput();
    createWorkspaceSnapshot(corrupt);
    createWorkspaceSnapshot(healthy);
    moveToHibernating(corrupt.repositoryUuid, corrupt.packetId);
    moveToHibernating(healthy.repositoryUuid, healthy.packetId);
    getSqlite().prepare(`
      UPDATE workspace_snapshots SET head_commit = ?
      WHERE repository_uuid = ? AND packet_id = ?
    `).run('tampered-head', corrupt.repositoryUuid, corrupt.packetId);

    const scan = scanWorkspaceSnapshotsForReconciliation();
    expect(scan.snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repositoryUuid: healthy.repositoryUuid,
        packetId: healthy.packetId,
        state: 'hibernating',
      }),
    ]));
    expect(scan.snapshots).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ packetId: corrupt.packetId }),
    ]));
    expect(scan.corruptions).toEqual([expect.objectContaining({
      repositoryUuid: corrupt.repositoryUuid,
      packetId: corrupt.packetId,
      note: expect.stringContaining('fingerprint'),
    })]);
    getSqlite().prepare(`
      UPDATE workspace_snapshots SET head_commit = ?
      WHERE repository_uuid = ? AND packet_id = ?
    `).run(corrupt.headCommit, corrupt.repositoryUuid, corrupt.packetId);
  });

  it.each([
    ['state', 'state', 'parked'],
    ['record version', 'record_version', 2],
    ['last transition id', 'last_transition_id', 'forged-transition'],
    ['updated time', 'updated_at', 9999],
  ])('rejects current %s corruption that disagrees with the receipt chain', (_label, column, value) => {
    const input = snapshotInput();
    createWorkspaceSnapshot(input);
    getSqlite().prepare(`
      UPDATE workspace_snapshots SET ${column} = ?
      WHERE repository_uuid = ? AND packet_id = ?
    `).run(value, input.repositoryUuid, input.packetId);

    expect(() => getWorkspaceSnapshot(input.repositoryUuid, input.packetId))
      .toThrow(/immutable transition receipts/);
    expect(() => createWorkspaceSnapshot(input))
      .toThrow(WorkspaceSnapshotCorruptError);
  });

  it('applies transitions with compare-and-set and replays an old receipt idempotently', () => {
    const input = snapshotInput();
    createWorkspaceSnapshot(input);
    const first = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'cas-parkable',
      expectedState: 'materialized',
      expectedVersion: 1,
      toState: 'parkable',
      transitionStartedAt: 5000,
      recordedAt: 5001,
    });
    expect(first.status).toBe('applied');
    expect(first.record?.version).toBe(2);

    const stale = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'stale-transition',
      expectedState: 'materialized',
      expectedVersion: 1,
      toState: 'parkable',
    });
    expect(stale.status).toBe('conflict');
    expect(stale.record).toMatchObject({ state: 'parkable', version: 2 });
    expect(listWorkspaceSnapshotTransitions(input.repositoryUuid, input.packetId))
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ transitionId: 'stale-transition' })]));

    const second = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'cas-hibernating',
      expectedState: 'parkable',
      expectedVersion: 2,
      toState: 'hibernating',
    });
    expect(second.status).toBe('applied');

    const replay = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'cas-parkable',
      expectedState: 'materialized',
      expectedVersion: 1,
      toState: 'parkable',
      transitionStartedAt: 9999,
      recordedAt: 9999,
    });
    expect(replay.status).toBe('idempotent');
    expect(replay.record).toMatchObject({ state: 'hibernating', version: 3 });
  });

  it('reads the projection row and receipt chain from one SQLite snapshot', () => {
    const input = snapshotInput();
    const created = createWorkspaceSnapshot(input).record;
    const sqlite = getSqlite();
    const writer = new Database(dbPath);
    writer.pragma('journal_mode = WAL');
    writer.pragma('busy_timeout = 5000');
    const originalPrepare = sqlite.prepare.bind(sqlite);
    let injected = false;
    const transitionId = `${input.packetId}-concurrent-parkable`;
    const recordedAt = created.updatedAt + 1;

    sqlite.prepare = ((source: string) => {
      if (!injected && source.includes('FROM workspace_snapshot_transitions')) {
        injected = true;
        writer.transaction(() => {
          writer.prepare(`
            UPDATE workspace_snapshots
            SET state = 'parkable', record_version = 2, last_transition_id = ?,
                transition_started_at = ?, state_entered_at = ?, updated_at = ?
            WHERE repository_uuid = ? AND packet_id = ?
          `).run(transitionId, recordedAt, recordedAt, recordedAt, input.repositoryUuid, input.packetId);
          writer.prepare(`
            INSERT INTO workspace_snapshot_transitions (
              repository_uuid, packet_id, transition_id, transition_kind, from_state,
              to_state, prior_version, resulting_version, transition_started_at,
              recorded_at, receipt_json, error_json, snapshot_fingerprint, snapshot_generation
            ) VALUES (?, ?, ?, 'transition', 'materialized', 'parkable', 1, 2, ?, ?, NULL, NULL, ?, 1)
          `).run(
            input.repositoryUuid,
            input.packetId,
            transitionId,
            recordedAt,
            recordedAt,
            created.snapshotFingerprint,
          );
        }).immediate();
      }
      return originalPrepare(source);
    }) as typeof sqlite.prepare;

    try {
      expect(getWorkspaceSnapshot(input.repositoryUuid, input.packetId)).toMatchObject({
        state: 'materialized',
        version: 1,
      });
    } finally {
      sqlite.prepare = originalPrepare;
      writer.close();
    }
    expect(injected).toBe(true);
    expect(getWorkspaceSnapshot(input.repositoryUuid, input.packetId)).toMatchObject({
      state: 'parkable',
      version: 2,
    });
  });

  it('rejects clock rollback and orders equal-time receipts by state-machine version', () => {
    const input = snapshotInput({ transitionStartedAt: 7000, recordedAt: 7001 });
    createWorkspaceSnapshot(input);
    expect(() => transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'clock-rollback',
      expectedState: 'materialized',
      expectedVersion: 1,
      toState: 'parkable',
      transitionStartedAt: 6999,
      recordedAt: 7000,
    })).toThrow(/cannot precede current updatedAt/);
    expect(getWorkspaceSnapshot(input.repositoryUuid, input.packetId)).toMatchObject({
      state: 'materialized',
      version: 1,
      updatedAt: 7001,
    });

    transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'z-equal-clock',
      expectedState: 'materialized',
      expectedVersion: 1,
      toState: 'parkable',
      transitionStartedAt: 7001,
      recordedAt: 7001,
    });
    transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'a-equal-clock',
      expectedState: 'parkable',
      expectedVersion: 2,
      toState: 'hibernating',
      transitionStartedAt: 7001,
      recordedAt: 7001,
    });
    const history = listWorkspaceSnapshotTransitions(input.repositoryUuid, input.packetId);
    expect(history.map((receipt) => receipt.resultingVersion)).toEqual([1, 2, 3]);
    expect(history.map((receipt) => receipt.transitionId)).toEqual([
      input.creationId,
      'z-equal-clock',
      'a-equal-clock',
    ]);
  });

  it('leaves an interrupted transitional state readable after closing and reopening SQLite', () => {
    const input = snapshotInput();
    createWorkspaceSnapshot(input);
    const interrupted = moveToHibernating(input.repositoryUuid, input.packetId);
    expect(interrupted).toMatchObject({ state: 'hibernating', version: 3 });

    closeDb();
    expect(getDb()).not.toBeNull();

    const recovered = listWorkspaceSnapshotsForReconciliation()
      .find((record) => record.repositoryUuid === input.repositoryUuid && record.packetId === input.packetId);
    expect(recovered).toEqual(interrupted);
    expect(listWorkspaceSnapshotTransitions(input.repositoryUuid, input.packetId).map((row) => row.toState))
      .toEqual(['materialized', 'parkable', 'hibernating']);
  });

  it('persists the complete park and restore cycle through restart reconciliation', () => {
    const input = snapshotInput();
    createWorkspaceSnapshot(input);
    moveToHibernating(input.repositoryUuid, input.packetId);
    const parked = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'cycle-parked',
      expectedState: 'hibernating',
      expectedVersion: 3,
      toState: 'parked',
      receipt: { checkoutMaterialized: false },
    });
    expect(parked.status).toBe('applied');
    const restoring = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'cycle-restoring',
      expectedState: 'parked',
      expectedVersion: 4,
      toState: 'restoring',
    });
    expect(restoring.status).toBe('applied');

    closeDb();
    expect(getDb()).not.toBeNull();
    expect(listWorkspaceSnapshotsForReconciliation()).toEqual(
      expect.arrayContaining([expect.objectContaining({
        repositoryUuid: input.repositoryUuid,
        packetId: input.packetId,
        state: 'restoring',
        version: 5,
      })]),
    );

    const materialized = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'cycle-materialized',
      expectedState: 'restoring',
      expectedVersion: 5,
      toState: 'materialized',
      receipt: { restoredTreeMatches: true },
    });
    expect(materialized.status).toBe('applied');
    expect(materialized.record).toMatchObject({ state: 'materialized', version: 6 });
  });

  it('records failure truth without guessing a transitional operation outcome', () => {
    const input = snapshotInput();
    createWorkspaceSnapshot(input);
    const hibernating = moveToHibernating(input.repositoryUuid, input.packetId);
    const error = {
      code: 'RECOVERY_REF_UNREADABLE',
      message: 'Recovery ref verification did not complete.',
      phase: 'hibernating',
      recordedAt: 6100,
      details: { commandExitCode: 128 },
    } as const;
    const failed = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'hibernate-error',
      expectedState: 'hibernating',
      expectedVersion: hibernating.version,
      toState: 'hibernating',
      error,
      transitionStartedAt: 6099,
      recordedAt: 6101,
    });
    expect(failed.status).toBe('applied');
    expect(failed.record).toMatchObject({
      state: 'hibernating',
      version: 4,
      lastError: error,
      lastErrorAt: 6100,
    });
    expect(listWorkspaceSnapshotsForReconciliation()).toEqual(
      expect.arrayContaining([expect.objectContaining({
        repositoryUuid: input.repositoryUuid,
        packetId: input.packetId,
        state: 'hibernating',
      })]),
    );
    const recovered = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'hibernate-recovered',
      expectedState: 'hibernating',
      expectedVersion: 4,
      toState: 'parked',
      transitionStartedAt: 6102,
      recordedAt: 6103,
    });
    expect(recovered.status).toBe('applied');
    expect(recovered.record).toMatchObject({
      state: 'parked',
      version: 5,
      lastError: null,
      lastErrorAt: null,
    });
    expect(listWorkspaceSnapshotTransitions(input.repositoryUuid, input.packetId))
      .toEqual(expect.arrayContaining([expect.objectContaining({
        transitionId: 'hibernate-error',
        error,
      })]));
  });

  it('rejects invalid transitions and transition-id reuse with different truth', () => {
    const input = snapshotInput();
    createWorkspaceSnapshot(input);
    expect(() => transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'skip-to-parked',
      expectedState: 'materialized',
      expectedVersion: 1,
      toState: 'parked',
    })).toThrow(WorkspaceSnapshotInputError);

    transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'reuse-me',
      expectedState: 'materialized',
      expectedVersion: 1,
      toState: 'parkable',
    });
    expect(() => transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: 'reuse-me',
      expectedState: 'parkable',
      expectedVersion: 2,
      toState: 'hibernating',
    })).toThrow(WorkspaceSnapshotTransitionReuseError);
  });

  it('keeps transition receipts append-only at the database boundary', () => {
    const input = snapshotInput();
    createWorkspaceSnapshot(input);
    const sqlite = getSqlite();
    expect(() => sqlite.prepare(`
      UPDATE workspace_snapshot_transitions SET recorded_at = recorded_at + 1
      WHERE repository_uuid = ? AND packet_id = ?
    `).run(input.repositoryUuid, input.packetId)).toThrow(/immutable/);
    expect(() => sqlite.prepare(`
      DELETE FROM workspace_snapshot_transitions
      WHERE repository_uuid = ? AND packet_id = ?
    `).run(input.repositoryUuid, input.packetId)).toThrow(/append-only/);
    expect(listWorkspaceSnapshotTransitions(input.repositoryUuid, input.packetId)).toHaveLength(1);
  });

  it('supersedes materialized truth with an append-only generation anchor across restart', () => {
    const input = snapshotInput();
    const created = createWorkspaceSnapshot(input).record;
    const generationInput = {
      ...input,
      laneId: `${input.laneId}-replacement`,
      headCommit: `${input.headCommit}-next`,
      treeSha: `${input.treeSha}-next`,
      recoveryRef: `${input.recoveryRef}/g2`,
      diffFingerprint: `${input.diffFingerprint}-next`,
      sessionIdentities: [{
        kind: 'worker',
        identity: `${input.packetId}-replacement-session`,
        runtime: 'codex',
        bindingId: `${input.packetId}-replacement-binding`,
      }],
      creationId: `${input.creationId}-generation-2`,
      expectedState: 'materialized' as const,
      expectedVersion: created.version,
      expectedGeneration: created.snapshotGeneration,
      transitionStartedAt: created.updatedAt + 1,
      recordedAt: created.updatedAt + 2,
      receipt: { source: 'replacement-lane' },
    };

    const advanced = beginWorkspaceSnapshotGeneration(generationInput);
    expect(advanced).toMatchObject({
      status: 'applied',
      record: {
        state: 'materialized',
        version: 2,
        snapshotGeneration: 2,
        laneId: generationInput.laneId,
        headCommit: generationInput.headCommit,
        recoveryRef: generationInput.recoveryRef,
      },
    });
    expect(beginWorkspaceSnapshotGeneration(generationInput)).toEqual({
      status: 'idempotent',
      record: advanced.record,
    });

    closeDb();
    expect(getDb()).not.toBeNull();
    expect(getWorkspaceSnapshot(input.repositoryUuid, input.packetId)).toEqual(advanced.record);
    const history = listWorkspaceSnapshotTransitions(input.repositoryUuid, input.packetId);
    expect(history.map((receipt) => [receipt.kind, receipt.snapshotGeneration])).toEqual([
      ['created', 1],
      ['created', 2],
    ]);
    expect(history[1]).toMatchObject({
      fromState: 'materialized',
      toState: 'materialized',
      receipt: {
        source: 'replacement-lane',
        previousSnapshotGeneration: 1,
        previousSnapshotFingerprint: created.snapshotFingerprint,
        previousSnapshot: {
          headCommit: created.headCommit,
          recoveryRef: created.recoveryRef,
          sessionIdentities: created.sessionIdentities,
        },
      },
    });

    const continued = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: `${input.packetId}-generation-2-parkable`,
      expectedState: 'materialized',
      expectedVersion: 2,
      expectedGeneration: 2,
      toState: 'parkable',
    });
    expect(continued).toMatchObject({
      status: 'applied',
      record: { version: 3, snapshotGeneration: 2, state: 'parkable' },
    });
  });

  it('keeps merge retirement terminal even with the cleanup-replacement capability', () => {
    const input = snapshotInput();
    const created = createWorkspaceSnapshot(input).record;
    const retiring = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: `${input.packetId}-merge-retiring`,
      expectedState: 'materialized',
      expectedVersion: created.version,
      expectedGeneration: created.snapshotGeneration,
      toState: 'retiring',
      receipt: { terminalAction: 'merge' },
    });
    if (retiring.status === 'missing') throw new Error('retiring snapshot disappeared');
    const retired = transitionWorkspaceSnapshot({
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      transitionId: `${input.packetId}-merge-retired`,
      expectedState: 'retiring',
      expectedVersion: retiring.record.version,
      expectedGeneration: retiring.record.snapshotGeneration,
      toState: 'retired',
      receipt: { terminalAction: 'merge' },
    });
    if (retired.status === 'missing') throw new Error('retired snapshot disappeared');

    expect(() => beginWorkspaceSnapshotGeneration({
      ...input,
      laneId: `${input.laneId}-replacement`,
      creationId: `${input.creationId}-forbidden-replacement`,
      expectedState: 'retired',
      expectedVersion: retired.record.version,
      expectedGeneration: retired.record.snapshotGeneration,
      retiredCleanupReplacement: true,
      transitionStartedAt: retired.record.updatedAt + 1,
      recordedAt: retired.record.updatedAt + 2,
      receipt: { source: 'replacement-owned-launch' },
    })).toThrow(/invalid generation supersession receipt/);
    expect(getWorkspaceSnapshot(input.repositoryUuid, input.packetId)).toMatchObject({
      state: 'retired',
      snapshotGeneration: 1,
    });
  });
});
