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
const { LEGACY_WORKTREE_DIR_NAME } = await import('@/lib/worktree/root-layout');

const materializedDependencies = {
  listRepos: async () => [{ id: '', localPath: '/tmp/repo' }],
  assertManagedWorkspaceMaterialization: async () => ({
    device: 1,
    inode: 2,
    canonicalPath: '/tmp/o8-guard-materialized',
  }),
  // Registered repositories resolve from the registry alone.
  findLaneByPacket: () => null,
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

describe('transient source repo ownership (no-snapshot branch)', () => {
  const TRANSIENT_REPO = '/tmp/o8-opencode-smoke.CvBoWi';
  const PACKET_ID = 'pkt-5436b404-8f9e-4dfe-b003-83893a701fa3';
  const LANE_ID = 'lane-011a0ae5-1a5';
  const MANAGED_ROOT = `/Users/o8/.o8/worktrees/o8-opencode-smoke.cvbowi-c08142afd275/${LEGACY_WORKTREE_DIR_NAME}`;
  const WORKTREE = `${MANAGED_ROOT}/packet-${PACKET_ID}`;
  const IDENTITY = { device: 16777222, inode: 496724602, canonicalPath: WORKTREE };

  /** Only the repo that actually created the worktree holds the manager receipt. */
  function receiptOwnedBy(ownerRepoPath: string, consulted: string[]) {
    return async (repoPath: string, workspacePath: string) => {
      consulted.push(repoPath);
      if (path.resolve(repoPath) !== path.resolve(ownerRepoPath)
        || path.resolve(workspacePath) !== path.resolve(WORKTREE)) {
        throw new Error('Managed workspace metadata is absent or does not own this path.');
      }
      return IDENTITY;
    };
  }

  function transientInput(overrides: Record<string, unknown> = {}) {
    return {
      surfaceId: `opencode-owned:${PACKET_ID}`,
      sessionPacketId: PACKET_ID,
      laneId: LANE_ID,
      runtimeId: 'opencode',
      mode: 'launch' as const,
      binding: {
        logicalWorkspaceId: `packet:${PACKET_ID}`,
        // Transient repos are never saved to the registry, so no uuid is pinned.
        repositoryUuid: null,
        packetId: PACKET_ID,
        cwd: WORKTREE,
        version: 1,
        verifiedAt: '2026-09-04T00:00:00.000Z',
      },
      repoPath: WORKTREE,
      ...overrides,
    };
  }

  it('consults the packet lane source repo that listRepos omits', async () => {
    const consulted: string[] = [];
    await expect(inspectOwnedWorkspaceMaterialization(transientInput(), {
      // A registered repo exists but does not own the transient worktree.
      listRepos: async () => [{ id: 'registered-uuid', localPath: '/Users/o8/o8' }],
      assertManagedWorkspaceMaterialization: receiptOwnedBy(TRANSIENT_REPO, consulted),
      findLaneByPacket: () => ({ id: LANE_ID, repoPath: TRANSIENT_REPO }),
    })).resolves.toEqual({ status: 'available', source: 'materialized', materializationIdentity: IDENTITY });
    // The exact source repo was asked, after the registry produced no owner.
    expect(consulted).toEqual(['/Users/o8/o8', TRANSIENT_REPO]);
  });

  it('accepts the manager collision suffix shape only when its receipt proves ownership', async () => {
    const consulted: string[] = [];
    const collisionWorktree = `${WORKTREE}-a1b2`;
    await expect(inspectOwnedWorkspaceMaterialization(transientInput({
      binding: { ...transientInput().binding, cwd: collisionWorktree },
      repoPath: collisionWorktree,
    }), {
      listRepos: async () => [],
      assertManagedWorkspaceMaterialization: async (repoPath: string, workspacePath: string) => {
        consulted.push(repoPath);
        if (repoPath !== TRANSIENT_REPO || workspacePath !== collisionWorktree) {
          throw new Error('Managed workspace metadata is absent or does not own this path.');
        }
        return { ...IDENTITY, canonicalPath: collisionWorktree };
      },
      findLaneByPacket: () => ({ id: LANE_ID, repoPath: TRANSIENT_REPO }),
    })).resolves.toMatchObject({ status: 'available', source: 'materialized' });
    expect(consulted).toEqual([TRANSIENT_REPO]);
  });

  it('refuses packet-prefix lookalikes outside the manager collision invariant', async () => {
    for (const suffix of ['retry', 'abc', 'abcde', 'AB12', 'ab_2']) {
      const consulted: string[] = [];
      const lookalike = `${WORKTREE}-${suffix}`;
      await expect(inspectOwnedWorkspaceMaterialization(transientInput({
        binding: { ...transientInput().binding, cwd: lookalike },
        repoPath: lookalike,
      }), {
        listRepos: async () => [],
        assertManagedWorkspaceMaterialization: receiptOwnedBy(TRANSIENT_REPO, consulted),
        findLaneByPacket: () => ({ id: LANE_ID, repoPath: TRANSIENT_REPO }),
      })).resolves.toMatchObject({ status: 'unknown' });
      expect(consulted, suffix).toEqual([]);
    }
  });

  it('never lets the fallback bypass a pinned repository identity', async () => {
    const consulted: string[] = [];
    await expect(inspectOwnedWorkspaceMaterialization(transientInput({
      binding: { ...transientInput().binding, repositoryUuid: 'registered-uuid' },
    }), {
      listRepos: async () => [{ id: 'registered-uuid', localPath: '/Users/o8/o8' }],
      assertManagedWorkspaceMaterialization: receiptOwnedBy(TRANSIENT_REPO, consulted),
      findLaneByPacket: () => ({ id: LANE_ID, repoPath: TRANSIENT_REPO }),
    })).resolves.toMatchObject({
      status: 'unknown',
      note: 'Managed workspace metadata is absent or does not own this path.',
    });
    expect(consulted).toEqual(['/Users/o8/o8']);
  });

  it('keeps registered ambiguity failing closed without consulting the lane', async () => {
    const consulted: string[] = [];
    await expect(inspectOwnedWorkspaceMaterialization(transientInput(), {
      listRepos: async () => [
        { id: 'a', localPath: '/Users/o8/one' },
        { id: 'b', localPath: '/Users/o8/two' },
      ],
      assertManagedWorkspaceMaterialization: async (repoPath: string) => {
        consulted.push(repoPath);
        return IDENTITY;
      },
      findLaneByPacket: () => ({ id: LANE_ID, repoPath: TRANSIENT_REPO }),
    })).resolves.toMatchObject({ status: 'unknown', note: expect.stringContaining('ambiguous') });
    expect(consulted).toEqual(['/Users/o8/one', '/Users/o8/two']);
  });

  it('refuses a cwd the packet lane source repo does not own', async () => {
    const consulted: string[] = [];
    await expect(inspectOwnedWorkspaceMaterialization(transientInput(), {
      listRepos: async () => [],
      // No repository holds a receipt for this path.
      assertManagedWorkspaceMaterialization: receiptOwnedBy('/private/tmp/other-repo', consulted),
      findLaneByPacket: () => ({ id: LANE_ID, repoPath: TRANSIENT_REPO }),
    })).resolves.toMatchObject({
      status: 'unknown',
      note: 'Managed workspace metadata is absent or does not own this path.',
    });
    expect(consulted).toEqual([TRANSIENT_REPO]);
  });

  it('refuses an arbitrary cwd that is not this packet managed worktree slot', async () => {
    const consulted: string[] = [];
    const arbitrary = '/Users/o8/somewhere-else';
    await expect(inspectOwnedWorkspaceMaterialization(transientInput({
      binding: { ...transientInput().binding, cwd: arbitrary },
      repoPath: arbitrary,
    }), {
      listRepos: async () => [],
      assertManagedWorkspaceMaterialization: receiptOwnedBy(TRANSIENT_REPO, consulted),
      findLaneByPacket: () => ({ id: LANE_ID, repoPath: TRANSIENT_REPO }),
    })).resolves.toMatchObject({ status: 'unknown' });
    expect(consulted).toEqual([]);
  });

  it('refuses when the launching lane is not the packet lane', async () => {
    const consulted: string[] = [];
    await expect(inspectOwnedWorkspaceMaterialization(transientInput({ laneId: 'lane-someone-else' }), {
      listRepos: async () => [],
      assertManagedWorkspaceMaterialization: receiptOwnedBy(TRANSIENT_REPO, consulted),
      findLaneByPacket: () => ({ id: LANE_ID, repoPath: TRANSIENT_REPO }),
    })).resolves.toMatchObject({ status: 'unknown' });
    expect(consulted).toEqual([]);
  });

  it('refuses when the launch carries no lane identity', async () => {
    const consulted: string[] = [];
    await expect(inspectOwnedWorkspaceMaterialization(transientInput({ laneId: null }), {
      listRepos: async () => [],
      assertManagedWorkspaceMaterialization: receiptOwnedBy(TRANSIENT_REPO, consulted),
      findLaneByPacket: () => ({ id: LANE_ID, repoPath: TRANSIENT_REPO }),
    })).resolves.toMatchObject({ status: 'unknown' });
    expect(consulted).toEqual([]);
  });

  it('refuses when the packet has no live lane', async () => {
    const consulted: string[] = [];
    await expect(inspectOwnedWorkspaceMaterialization(transientInput(), {
      listRepos: async () => [],
      assertManagedWorkspaceMaterialization: receiptOwnedBy(TRANSIENT_REPO, consulted),
      findLaneByPacket: () => null,
    })).resolves.toMatchObject({ status: 'unknown' });
    expect(consulted).toEqual([]);
  });
});
