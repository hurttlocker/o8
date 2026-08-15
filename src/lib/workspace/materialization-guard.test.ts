import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-materialization-guard-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const {
  createWorkspaceSnapshot,
  transitionWorkspaceSnapshot,
} = await import('@/lib/worktree/snapshot-state');
const { inspectOwnedWorkspaceMaterialization } = await import('./materialization-guard');

const materializedDependencies = {
  listRepos: async () => [{ id: '', localPath: '/tmp/repo' }],
  assertManagedWorkspaceMaterialization: async () => ({
    device: 1,
    inode: 2,
    canonicalPath: '/tmp/o8-guard-materialized',
  }),
};

let sequence = 0;

function snapshotInput(packetId?: string) {
  sequence += 1;
  return {
    repositoryUuid: `guard-repo-${sequence}`,
    packetId: packetId ?? `guard-packet-${sequence}`,
    laneId: `guard-lane-${sequence}`,
    originalPath: `/tmp/o8-guard-workspace-${sequence}`,
    branch: `inline/guard-${sequence}`,
    baseCommit: `guard-base-${sequence}`,
    headCommit: `guard-head-${sequence}`,
    treeSha: `guard-tree-${sequence}`,
    recoveryRef: `refs/o8/recovery/guard-${sequence}`,
    diffFingerprint: `guard-diff-${sequence}`,
    sessionIdentities: [{ kind: 'owned-session', identity: `guard-session-${sequence}` }],
    creationId: `guard-create-${sequence}`,
  };
}

function guardInput(input: ReturnType<typeof snapshotInput>) {
  return {
    surfaceId: `guard-owned:${input.packetId}`,
    sessionPacketId: input.packetId,
    binding: {
      logicalWorkspaceId: `packet:${input.packetId}`,
      repositoryUuid: input.repositoryUuid,
      packetId: input.packetId,
      cwd: input.originalPath,
      version: 1,
      verifiedAt: '2026-08-15T00:00:00.000Z',
    },
    repoPath: input.originalPath,
  };
}

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('owned workspace materialization guard', () => {
  it('requires manager ownership without a snapshot and holds every non-materialized state', async () => {
    const input = snapshotInput();
    const exactDependencies = {
      ...materializedDependencies,
      listRepos: async () => [{ id: input.repositoryUuid, localPath: '/tmp/repo' }],
    };
    await expect(inspectOwnedWorkspaceMaterialization(guardInput(input), exactDependencies))
      .resolves.toEqual({
        status: 'available',
        source: 'materialized',
        materializationIdentity: {
          device: 1,
          inode: 2,
          canonicalPath: '/tmp/o8-guard-materialized',
        },
      });
    let snapshot = createWorkspaceSnapshot(input).record;
    await expect(inspectOwnedWorkspaceMaterialization(guardInput(input), exactDependencies))
      .resolves.toEqual({
        status: 'available',
        source: 'materialized',
        materializationIdentity: {
          device: 1,
          inode: 2,
          canonicalPath: '/tmp/o8-guard-materialized',
        },
      });

    for (const state of ['parkable', 'hibernating', 'parked', 'restoring'] as const) {
      const result = transitionWorkspaceSnapshot({
        repositoryUuid: input.repositoryUuid,
        packetId: input.packetId,
        transitionId: `guard-${state}-${sequence}`,
        expectedState: snapshot.state,
        expectedVersion: snapshot.version,
        toState: state,
      });
      if (result.status !== 'applied') throw new Error(`Could not stage ${state}.`);
      snapshot = result.record;
      await expect(inspectOwnedWorkspaceMaterialization(guardInput(input))).resolves.toMatchObject({
        status: 'held', state, note: expect.stringContaining(state),
      });
    }
  });

  it('fails closed for ambiguous, mismatched, and corrupt packet truth', async () => {
    const packetId = `guard-shared-${sequence + 1}`;
    const first = snapshotInput(packetId);
    createWorkspaceSnapshot(first);
    await expect(inspectOwnedWorkspaceMaterialization({
      ...guardInput(first),
      repoPath: `${first.originalPath}-mismatch`,
    })).resolves.toMatchObject({ status: 'unknown' });

    const second = snapshotInput(packetId);
    createWorkspaceSnapshot(second);
    await expect(inspectOwnedWorkspaceMaterialization(guardInput(first)))
      .resolves.toMatchObject({ status: 'unknown', note: expect.stringContaining('ambiguous') });

    const corrupt = snapshotInput();
    createWorkspaceSnapshot(corrupt);
    getSqlite().prepare(`
      UPDATE workspace_snapshots SET session_identity_json = '{'
      WHERE repository_uuid = ? AND packet_id = ?
    `).run(corrupt.repositoryUuid, corrupt.packetId);
    await expect(inspectOwnedWorkspaceMaterialization(guardInput(corrupt)))
      .resolves.toMatchObject({ status: 'unknown', note: expect.stringContaining('could not be verified') });
  });
});
