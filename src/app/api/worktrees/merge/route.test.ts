import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Lane } from '@/lib/lane/types';
import type { WorkspaceSnapshotRecord } from '@/lib/worktree/snapshot-state-types';

const h = vi.hoisted(() => ({
  cleanup: vi.fn(),
  findRepoByLocalPath: vi.fn(),
  getWorktree: vi.fn(),
  identity: { device: 1, inode: 2, canonicalPath: '/tmp/o8-mobile-route-worktree' },
  lanes: [] as Lane[],
  snapshots: [] as WorkspaceSnapshotRecord[],
}));

vi.mock('@/lib/lane/registry', () => ({
  findLatestLaneByPacket: (packetId: string) => h.lanes.find((lane) => lane.packetId === packetId),
  listLanes: () => h.lanes,
}));
vi.mock('@/lib/repos/registry', () => ({
  findRepoByLocalPath: h.findRepoByLocalPath,
  listRepos: () => [],
}));
vi.mock('@/lib/worktree/snapshot-state', () => ({
  listWorkspaceSnapshotsByPacketId: () => h.snapshots,
  listWorkspaceSnapshotsByRepositoryUuid: (repositoryUuid: string) => (
    h.snapshots.filter((snapshot) => snapshot.repositoryUuid === repositoryUuid)
  ),
}));
vi.mock('@/lib/worktree/launch', () => ({
  getWorktreeManager: () => ({ get: h.getWorktree, cleanup: h.cleanup }),
}));
vi.mock('@/lib/workspace/managed-materialization-identity', () => ({
  assertManagedWorkspaceMaterialization: vi.fn(async () => h.identity),
}));
vi.mock('@/lib/realtime/publisher', () => ({ requestRealtimeRefresh: vi.fn() }));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-mobile-worktree-route-'));
const deviceToken = 'route-device-token-0123456789abcdef';
writeFileSync(path.join(dataDir, 'ws-token'), 'route-operator-token-0123456789abcdef\n');
writeFileSync(
  path.join(dataDir, 'mobile-device-tokens'),
  `${createHash('sha256').update(deviceToken).digest('hex')}\n`,
);
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { panelGateMiddleware } = await import('@/middleware');
const { withPacketLifecycleMutationLock } = await import('@/lib/orchestrator/lifecycle-mutation-lock');
const { createWorktreeMergePostForTesting } = await import('./handler');
const post = createWorktreeMergePostForTesting({
  discardExact: async () => { await h.cleanup(); },
});

const packetId = 'packet-mobile-route';
const repoPath = '/tmp/o8-mobile-route-repo';
const workspacePath = '/tmp/o8-mobile-route-worktree';

function lane(): Lane {
  return {
    id: 'lane-mobile-route',
    projectId: null,
    label: 'Mobile route lane',
    repoPath,
    worktreePath: workspacePath,
    branch: 'inline/mobile-route',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: 'owned:mobile-route',
    packetId,
    prNumber: null,
    status: 'reviewing',
    outcome: null,
    outcomeNote: null,
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    lastEventAt: null,
    lastEventLabel: null,
  };
}

function snapshot(state: WorkspaceSnapshotRecord['state']): WorkspaceSnapshotRecord {
  return {
    repositoryUuid: 'repo-mobile-route',
    packetId,
    missionId: 'mission-mobile-route',
    laneId: 'lane-mobile-route',
    originalPath: workspacePath,
    branch: 'inline/mobile-route',
    baseCommit: 'a'.repeat(40),
    headCommit: 'b'.repeat(40),
    treeSha: 'c'.repeat(40),
    recoveryRef: 'refs/o8/recovery/mobile-route',
    diffFingerprint: 'mobile-route-diff',
    dependencyRecipeKey: null,
    sessionIdentities: [],
    reservation: null,
    snapshotFingerprint: 'mobile-route-snapshot',
    snapshotGeneration: 1,
    state,
    version: 1,
    lastTransitionId: 'transition-mobile-route',
    transitionStartedAt: 1,
    stateEnteredAt: 1,
    lastError: null,
    lastErrorAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function request(action: 'pr' | 'merge' | 'discard'): NextRequest {
  return new NextRequest('http://o8.remote/api/worktrees/merge', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deviceToken}`,
      'content-type': 'application/json',
      'x-o8-client-addr': '192.0.2.10',
    },
    body: JSON.stringify({ repo: repoPath, worktreeId: 'packet-mobile-route', action }),
  });
}

async function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('mobile worktree publication route', () => {
  beforeEach(() => {
    h.cleanup.mockReset().mockResolvedValue(undefined);
    h.findRepoByLocalPath.mockReset().mockResolvedValue({
      id: 'repo-mobile-route',
      localPath: repoPath,
    });
    h.getWorktree.mockReset().mockResolvedValue({
      id: 'packet-mobile-route',
      path: workspacePath,
      branch: 'inline/mobile-route',
      baseBranch: 'main',
      agentType: 'codex',
      status: 'ready',
      createdAt: 1,
      lastActivityAt: 1,
      dirtyFiles: ['tracked.ts'],
      claudeManaged: false,
      isolationKind: 'git-worktree',
    });
    h.lanes = [lane()];
    h.snapshots = [snapshot('materialized')];
  });

  it('accepts the paired-device principal through middleware and the real handler', async () => {
    expect(panelGateMiddleware(request('discard')).headers.get('x-middleware-next')).toBe('1');

    const response = await post(request('discard'));

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(h.cleanup).toHaveBeenCalledOnce();
  });

  it.each(['pr', 'merge', 'discard'] as const)(
    'refuses parked %s before any Git, network, or cleanup mutation',
    async (action) => {
      h.snapshots = [snapshot('parked')];

      const response = await post(request(action));

      expect(response.status).toBe(409);
      expect(h.cleanup).not.toHaveBeenCalled();
    },
  );

  it('holds the packet lifecycle lock through cleanup so parking observes the publication first', async () => {
    const cleanupStarted = await deferred();
    const releaseCleanup = await deferred();
    h.cleanup.mockImplementationOnce(async () => {
      cleanupStarted.resolve();
      await releaseCleanup.promise;
    });

    const publication = post(request('discard'));
    await cleanupStarted.promise;
    const lifecycle = withPacketLifecycleMutationLock(packetId, async ({ contended }) => contended);
    releaseCleanup.resolve();

    expect((await publication).status).toBe(200);
    expect(await lifecycle).toBe(true);
  });

  it('refuses publication when a lifecycle transition wins the lock first', async () => {
    const lifecycleStarted = await deferred();
    const releaseLifecycle = await deferred();
    const lifecycle = withPacketLifecycleMutationLock(packetId, async () => {
      h.snapshots = [snapshot('parked')];
      lifecycleStarted.resolve();
      await releaseLifecycle.promise;
    });
    await lifecycleStarted.promise;

    const publication = post(request('discard'));
    releaseLifecycle.resolve();
    await lifecycle;

    expect((await publication).status).toBe(409);
    expect(h.cleanup).not.toHaveBeenCalled();
  });
});
