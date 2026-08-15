import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import type { Lane } from '@/lib/lane/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';
import type { OwnedWorkspaceBindingReceipt } from '@/lib/runtimes/shared/owned-session';
import type { WorktreeMetaEntry } from '@/lib/worktree/types';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-snapshot-generations-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { closeDb, getDb } = await import('@/lib/db');
const { registerOwnedSessionLifecycleHandler } = await import('@/lib/runtimes/shared/owned-session-lifecycle');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const { getWorkspaceSnapshot, listWorkspaceSnapshotTransitions } = await import('@/lib/worktree/snapshot-state');
const { parkWorkspace } = await import('./hibernator');
const { restoreWorkspace } = await import('./restorer');
const { materializeReplacementWorkspace } = await import('./replacement-materialization');

const roots: string[] = [];
let sequence = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(label: string) {
  sequence += 1;
  const root = mkdtempSync(path.join(os.tmpdir(), `o8-generation-${label}-`));
  roots.push(root);
  process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
  const repoPath = path.join(root, 'repo');
  mkdirSync(repoPath);
  git(repoPath, 'init', '-q', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'o8-test@example.test');
  git(repoPath, 'config', 'user.name', 'o8 test');
  writeFileSync(path.join(repoPath, 'tracked.txt'), 'base\n');
  git(repoPath, 'add', 'tracked.txt');
  git(repoPath, 'commit', '-qm', 'base');

  const repoId = `repo-generation-${sequence}`;
  const packetId = `packet-generation-${sequence}`;
  const metadataPath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json');
  mkdirSync(path.dirname(metadataPath), { recursive: true });
  let generation = 1;
  let lane = createLane(generation);
  let binding = createBinding(lane);
  registerOwnedSessionLifecycleHandler({
    runtimeId: 'codex',
    surfaceIdPrefix: `generation-${sequence}:`,
    commandLabel: 'generation-test',
    resolveRoot: () => root,
    sessionState: async () => 'active',
    archiveSession: async () => ({ archived: false, note: 'unused' }),
    getWorkspaceBinding: async () => binding,
    rebindWorkspace: async (_surfaceId, input) => {
      if (input.expectedVersion !== binding.binding.version
        || path.resolve(input.expectedCwd) !== path.resolve(binding.binding.cwd)) {
        return { status: 'conflict', receipt: binding, note: 'binding mismatch' };
      }
      binding = {
        ...binding,
        binding: {
          ...binding.binding,
          repositoryUuid: repoId,
          cwd: path.resolve(input.nextCwd),
          version: binding.binding.version + 1,
        },
      };
      return { status: 'rebound', receipt: binding };
    },
  });
  const repo: RepoRegistryEntry = {
    id: repoId,
    name: label,
    localPath: repoPath,
    remoteUrl: null,
    defaultBranch: 'main',
    addedAt: '2026-08-15T00:00:00.000Z',
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'copy',
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'git-worktree',
    },
  };

  function createLane(nextGeneration: number): Lane {
    const worktreeId = `packet-${packetId}-run-${nextGeneration}`;
    const worktreePath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
    const branch = `inline/${packetId}-run-${nextGeneration}`;
    git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath, 'main');
    writeFileSync(path.join(worktreePath, 'tracked.txt'), `generation ${nextGeneration}\n`);
    git(worktreePath, 'add', 'tracked.txt');
    git(worktreePath, 'commit', '-qm', `generation ${nextGeneration}`);
    const metadata = existsSync(metadataPath)
      ? JSON.parse(readFileSync(metadataPath, 'utf8')) as { version: number; worktrees: Record<string, unknown> }
      : { version: 1, worktrees: {} };
    metadata.worktrees[worktreeId] = {
      id: worktreeId,
      agentType: 'codex',
      sessionKey: `generation-${sequence}:session-${nextGeneration}`,
      baseBranch: 'main',
      createdAt: nextGeneration,
      claudeManaged: false,
      taskName: worktreeId,
      branchName: branch,
      status: 'ready',
      isolationKind: 'git-worktree',
      materializationIdentity: {
        device: lstatSync(worktreePath).dev,
        inode: lstatSync(worktreePath).ino,
        canonicalPath: realpathSync(worktreePath),
      },
    };
    writeFileSync(metadataPath, JSON.stringify(metadata));
    return {
      id: `lane-generation-${sequence}-${nextGeneration}`,
      projectId: null,
      label,
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      sessionKey: `generation-${sequence}:session-${nextGeneration}`,
      packetId,
      prNumber: null,
      status: 'reviewing',
      ownership: 'managed',
      writerToken: null,
      lastHeartbeatAt: null,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
      lastEventAt: null,
      lastEventLabel: null,
    };
  }

  function createBinding(nextLane: Lane): OwnedWorkspaceBindingReceipt {
    return {
      surfaceId: nextLane.sessionKey!,
      runtimeId: 'codex',
      sessionState: 'active',
      binding: {
        logicalWorkspaceId: `packet:${packetId}`,
        repositoryUuid: null,
        packetId,
        cwd: nextLane.worktreePath!,
        version: 1,
        verifiedAt: '2026-08-15T00:00:00.000Z',
      },
      activeRun: null,
      retainedRuns: [],
      retainedRunsComplete: true,
      retainedRunTotal: 0,
    };
  }

  return {
    repo,
    packetId,
    lane: () => lane,
    nextLane: () => {
      generation += 1;
      lane = createLane(generation);
      binding = createBinding(lane);
      return lane;
    },
    setAbsentReplacementLane: () => {
      generation += 1;
      lane = {
        ...lane,
        id: `lane-generation-${sequence}-${generation}`,
        worktreePath: path.join(resolveWorktreeRootLayout(repoPath).primaryBase, `absent-${generation}`),
        sessionKey: `generation-${sequence}:session-${generation}`,
      };
      binding = createBinding(lane);
    },
  };
}

function dependencies(f: ReturnType<typeof fixture>) {
  return {
    listRepos: async () => [f.repo],
    findLaneByPacket: () => f.lane(),
    processProbe: async (sessionKey: string) => ({
      state: 'quiescent' as const,
      identity: { ownership: 'owned' as const, pidIdentity: 'not_applicable' as const, sessionKey },
      probes: [],
      reasons: [],
      checkedAt: '2026-08-15T00:00:00.000Z',
    }),
    measureStorage: async (target: string) => ({
      availableBytes: existsSync(target) ? 1_000_000 : 2_000_000,
      logicalBytes: existsSync(target) ? 100_000 : null,
      measuredAt: '2026-08-15T00:00:00.000Z',
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('workspace snapshot generations through production lifecycle services', { timeout: 120_000 }, () => {
  it('parks, restores, accepts new committed work, reparks, restarts, and restores generation two', async () => {
    const f = fixture('roundtrip');
    expect(await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-roundtrip-park-1',
    }, dependencies(f))).toMatchObject({ status: 'parked', snapshot: { snapshotGeneration: 1 } });
    expect(await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-roundtrip-restore-1',
    }, dependencies(f))).toMatchObject({ status: 'restored' });

    writeFileSync(path.join(f.lane().worktreePath!, 'tracked.txt'), 'new work after restore\n');
    git(f.lane().worktreePath!, 'add', 'tracked.txt');
    git(f.lane().worktreePath!, 'commit', '-qm', 'new work after restore');
    const nextHead = git(f.lane().worktreePath!, 'rev-parse', 'HEAD');
    const reparked = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-roundtrip-park-2',
    }, dependencies(f));
    expect(reparked.status, reparked.status === 'refused' ? reparked.note : '').toBe('parked');
    expect(reparked).toMatchObject({
      status: 'parked',
      snapshot: { snapshotGeneration: 2, headCommit: nextHead },
    });
    const generationOneRef = `refs/o8/recovery/${f.repo.id}/${f.packetId}`;
    expect(git(f.repo.localPath, 'rev-parse', generationOneRef)).toBeTruthy();
    expect(getWorkspaceSnapshot(f.repo.id, f.packetId)?.recoveryRef).toBe(`${generationOneRef}-g2`);

    closeDb();
    expect(getDb()).not.toBeNull();
    expect(getWorkspaceSnapshot(f.repo.id, f.packetId)).toMatchObject({
      state: 'parked',
      snapshotGeneration: 2,
      headCommit: nextHead,
    });
    expect(await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-roundtrip-restore-2',
    }, dependencies(f))).toMatchObject({ status: 'restored', snapshot: { snapshotGeneration: 2 } });
    expect(git(f.lane().worktreePath!, 'rev-parse', 'HEAD')).toBe(nextHead);
  }, 120_000);

  it('retries after a post-capture scan failure without poisoning materialized truth', async () => {
    const f = fixture('retry');
    const refused = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-retry-failed',
    }, {
      ...dependencies(f),
      secondScan: async () => { throw new Error('synthetic scan drift'); },
    });
    expect(refused).toMatchObject({
      status: 'refused',
      snapshot: { state: 'materialized', snapshotGeneration: 1 },
    });
    expect(await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-retry-success',
    }, dependencies(f))).toMatchObject({
      status: 'parked',
      snapshot: { snapshotGeneration: 1 },
    });
    expect(listWorkspaceSnapshotTransitions(f.repo.id, f.packetId)
      .filter((receipt) => receipt.kind === 'created')).toHaveLength(1);
  });

  it('keeps parked truth when a replacement lane is absent, then supersedes it once materialized', async () => {
    const f = fixture('replacement');
    expect(await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-replacement-park-1',
    }, dependencies(f))).toMatchObject({ status: 'parked', snapshot: { snapshotGeneration: 1 } });
    const first = getWorkspaceSnapshot(f.repo.id, f.packetId)!;

    f.setAbsentReplacementLane();
    expect(await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-replacement-absent',
    }, dependencies(f))).toMatchObject({ status: 'refused' });
    expect(getWorkspaceSnapshot(f.repo.id, f.packetId)).toMatchObject({
      state: 'parked',
      snapshotGeneration: 1,
      snapshotFingerprint: first.snapshotFingerprint,
    });

    const replacement = f.nextLane();
    const replacementPark = await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-replacement-park-2',
    }, dependencies(f));
    expect(
      replacementPark.status,
      replacementPark.status === 'refused' ? replacementPark.note : '',
    ).toBe('parked');
    expect(replacementPark).toMatchObject({
      status: 'parked',
      snapshot: {
        snapshotGeneration: 2,
        laneId: replacement.id,
        originalPath: replacement.worktreePath,
      },
    });
    expect(listWorkspaceSnapshotTransitions(f.repo.id, f.packetId)
      .filter((receipt) => receipt.kind === 'created')).toHaveLength(2);
  });

  it('materializes one exact reset replacement before spawn and replays it across DB reopen', async () => {
    const f = fixture('prelaunch-replacement');
    expect(await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-prelaunch-park',
    }, dependencies(f))).toMatchObject({ status: 'parked', snapshot: { snapshotGeneration: 1 } });
    const parked = getWorkspaceSnapshot(f.repo.id, f.packetId)!;
    const priorRecoveryHead = git(f.repo.localPath, 'rev-parse', parked.recoveryRef);
    const lane = f.lane();
    git(f.repo.localPath, 'branch', '-D', lane.branch);
    git(f.repo.localPath, 'worktree', 'add', '-qb', lane.branch, parked.originalPath, 'main');
    lane.id = `${lane.id}-replacement`;
    lane.worktreePath = parked.originalPath;
    lane.status = 'launching';
    lane.sessionKey = null;
    const metadata: WorktreeMetaEntry = {
      id: path.basename(parked.originalPath),
      agentType: 'codex',
      baseBranch: 'main',
      createdAt: 2,
      claudeManaged: false,
      taskName: 'replacement',
      branchName: lane.branch,
      status: 'ready',
      isolationKind: 'git-worktree',
      materializationIdentity: {
        device: lstatSync(parked.originalPath).dev,
        inode: lstatSync(parked.originalPath).ino,
        canonicalPath: realpathSync(parked.originalPath),
      },
    };
    const proof = {
      laneId: lane.id,
      packetId: f.packetId,
      workspacePath: parked.originalPath,
      runtimeId: 'codex',
      surfaceId: `${f.packetId}:replacement-surface`,
    };
    const materializationDependencies = {
      getLane: (laneId: string) => laneId === lane.id ? lane : null,
      findRepoByLocalPath: async () => f.repo,
      readWorktreeMetadata: async () => metadata,
    };

    const materialized = await materializeReplacementWorkspace(
      parked,
      proof,
      materializationDependencies,
    );
    expect(materialized).toMatchObject({
      state: 'materialized',
      snapshotGeneration: 2,
      laneId: lane.id,
      originalPath: parked.originalPath,
    });
    expect(git(f.repo.localPath, 'rev-parse', parked.recoveryRef)).toBe(priorRecoveryHead);

    closeDb();
    expect(getDb()).not.toBeNull();
    const reopened = getWorkspaceSnapshot(f.repo.id, f.packetId)!;
    await expect(materializeReplacementWorkspace(
      reopened,
      proof,
      materializationDependencies,
    )).resolves.toEqual(reopened);
    expect(listWorkspaceSnapshotTransitions(f.repo.id, f.packetId)
      .filter((receipt) => receipt.kind === 'created')).toHaveLength(2);
  });

  it('supersedes a restored old lane before a reset replacement starts', async () => {
    const f = fixture('restored-prelaunch-replacement');
    expect(await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'restored-prelaunch-park',
    }, dependencies(f))).toMatchObject({ status: 'parked' });
    expect(await restoreWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'restored-prelaunch-restore',
    }, dependencies(f))).toMatchObject({ status: 'restored' });
    const restored = getWorkspaceSnapshot(f.repo.id, f.packetId)!;
    const oldLane = f.lane();
    git(f.repo.localPath, 'worktree', 'remove', '--force', restored.originalPath);
    git(f.repo.localPath, 'branch', '-D', oldLane.branch);
    const lane = f.nextLane();
    git(f.repo.localPath, 'worktree', 'remove', '--force', lane.worktreePath!);
    git(f.repo.localPath, 'worktree', 'add', '-q', restored.originalPath, lane.branch);
    lane.worktreePath = restored.originalPath;
    lane.status = 'launching';
    lane.sessionKey = null;
    const metadata: WorktreeMetaEntry = {
      id: path.basename(restored.originalPath), agentType: 'codex', baseBranch: 'main',
      createdAt: 2, claudeManaged: false, taskName: 'restored-replacement',
      branchName: lane.branch, status: 'ready', isolationKind: 'git-worktree',
      materializationIdentity: {
        device: lstatSync(restored.originalPath).dev,
        inode: lstatSync(restored.originalPath).ino,
        canonicalPath: realpathSync(restored.originalPath),
      },
    };
    const proof = {
      laneId: lane.id, packetId: f.packetId, workspacePath: restored.originalPath,
      runtimeId: 'codex', surfaceId: `${f.packetId}:restored-replacement`,
    };
    const materializationDependencies = {
      getLane: (laneId: string) => laneId === lane.id ? lane : null,
      findRepoByLocalPath: async () => f.repo,
      readWorktreeMetadata: async () => metadata,
    };

    const materialized = await materializeReplacementWorkspace(
      restored,
      proof,
      materializationDependencies,
    );
    expect(materialized).toMatchObject({
      state: 'materialized',
      snapshotGeneration: restored.snapshotGeneration + 1,
      laneId: lane.id,
      originalPath: restored.originalPath,
    });
    await expect(materializeReplacementWorkspace(
      materialized,
      proof,
      materializationDependencies,
    )).resolves.toEqual(materialized);
    expect(listWorkspaceSnapshotTransitions(f.repo.id, f.packetId)
      .filter((receipt) => receipt.kind === 'created')).toHaveLength(2);
  });

  it('keeps parked truth when the replacement path is absent or an unrelated occupant', async () => {
    const f = fixture('prelaunch-conflict');
    expect(await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-prelaunch-conflict-park',
    }, dependencies(f))).toMatchObject({ status: 'parked' });
    const parked = getWorkspaceSnapshot(f.repo.id, f.packetId)!;
    const lane = f.lane();
    lane.id = `${lane.id}-replacement`;
    lane.worktreePath = parked.originalPath;
    lane.status = 'launching';
    lane.sessionKey = null;
    const metadata: WorktreeMetaEntry = {
      id: path.basename(parked.originalPath), agentType: 'codex', baseBranch: 'main',
      createdAt: 2, claudeManaged: false, taskName: 'replacement',
      branchName: lane.branch, status: 'ready', isolationKind: 'git-worktree',
    };
    const proof = {
      laneId: lane.id, packetId: f.packetId, workspacePath: parked.originalPath,
      runtimeId: 'codex', surfaceId: `${f.packetId}:replacement-conflict`,
    };
    const baseDependencies = {
      getLane: (laneId: string) => laneId === lane.id ? lane : null,
      findRepoByLocalPath: async () => f.repo,
    };

    await expect(materializeReplacementWorkspace(parked, proof, {
      ...baseDependencies,
      readWorktreeMetadata: async () => null,
    })).rejects.toThrow('manager-provisioned');
    expect(getWorkspaceSnapshot(f.repo.id, f.packetId)).toEqual(parked);

    mkdirSync(parked.originalPath, { recursive: true });
    writeFileSync(path.join(parked.originalPath, 'external-sentinel.txt'), 'unrelated occupant\n');
    await expect(materializeReplacementWorkspace(parked, proof, {
      ...baseDependencies,
      readWorktreeMetadata: async () => metadata,
    })).rejects.toThrow();
    expect(readFileSync(path.join(parked.originalPath, 'external-sentinel.txt'), 'utf8'))
      .toBe('unrelated occupant\n');
    expect(getWorkspaceSnapshot(f.repo.id, f.packetId)).toEqual(parked);
  });

  it('refuses to bless a clean same-repo same-HEAD replacement with a different inode', async () => {
    const f = fixture('prelaunch-same-head-owner-swap');
    expect(await parkWorkspace({
      repositoryUuid: f.repo.id,
      packetId: f.packetId,
      operationId: 'generation-prelaunch-owner-swap-park',
    }, dependencies(f))).toMatchObject({ status: 'parked' });
    const parked = getWorkspaceSnapshot(f.repo.id, f.packetId)!;
    const lane = f.lane();
    git(f.repo.localPath, 'worktree', 'add', '-q', parked.originalPath, lane.branch);
    const managerIdentity = {
      device: lstatSync(parked.originalPath).dev,
      inode: lstatSync(parked.originalPath).ino,
      canonicalPath: realpathSync(parked.originalPath),
    };
    const retained = path.join(path.dirname(f.repo.localPath), 'manager-created-replacement');
    renameSync(parked.originalPath, retained);
    git(f.repo.localPath, 'clone', '-q', '--local', '--no-checkout', f.repo.localPath, parked.originalPath);
    git(parked.originalPath, 'checkout', '-q', '-B', lane.branch, parked.headCommit);
    lane.id = `${lane.id}-replacement`;
    lane.worktreePath = parked.originalPath;
    lane.status = 'launching';
    lane.sessionKey = null;
    const metadata: WorktreeMetaEntry = {
      id: path.basename(parked.originalPath), agentType: 'codex', baseBranch: 'main',
      createdAt: 2, claudeManaged: false, taskName: 'replacement',
      branchName: lane.branch, status: 'ready', isolationKind: 'git-worktree',
      materializationIdentity: managerIdentity,
    };

    await expect(materializeReplacementWorkspace(parked, {
      laneId: lane.id,
      packetId: f.packetId,
      workspacePath: parked.originalPath,
      runtimeId: 'codex',
      surfaceId: `${f.packetId}:replacement-owner-swap`,
    }, {
      getLane: (laneId: string) => laneId === lane.id ? lane : null,
      findRepoByLocalPath: async () => f.repo,
      readWorktreeMetadata: async () => metadata,
    })).rejects.toThrow('ownership changed');
    expect(git(retained, 'rev-parse', 'HEAD')).toBe(parked.headCommit);
    expect(git(parked.originalPath, 'rev-parse', 'HEAD')).toBe(parked.headCommit);
    expect(getWorkspaceSnapshot(f.repo.id, f.packetId)).toEqual(parked);
  });
});
