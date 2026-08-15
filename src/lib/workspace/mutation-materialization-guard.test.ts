import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-mutation-materialization-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
const root = mkdtempSync(path.join(os.tmpdir(), 'o8-parked-publish-'));
const repoPath = path.join(root, 'repo');
const occupiedPath = path.join(root, 'occupied-packet-path');
const repositoryUuid = 'repo-parked-publish';
mkdirSync(repoPath);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

git(repoPath, 'init', '-b', 'main');
git(repoPath, 'config', 'user.name', 'o8-test');
git(repoPath, 'config', 'user.email', 'o8@example.test');
writeFileSync(path.join(repoPath, 'tracked.txt'), 'reviewed bytes\n');
git(repoPath, 'add', 'tracked.txt');
git(repoPath, 'commit', '-m', 'reviewed');
git(root, 'clone', repoPath, occupiedPath);
writeFileSync(path.join(dataDir, 'repos.json'), JSON.stringify({
  version: 1,
  repos: [{
    id: repositoryUuid,
    name: 'parked-publish-test',
    localPath: repoPath,
    remoteUrl: null,
    defaultBranch: 'main',
    isGitRepo: true,
    addedAt: new Date().toISOString(),
    lastOpenedAt: new Date().toISOString(),
  }],
}));

const { closeDb } = await import('@/lib/db');
const { dispatch } = await import('@/lib/lane/commands');
const { createLane } = await import('@/lib/lane/registry');
const { withPacketLifecycleMutationLock } = await import('@/lib/orchestrator/lifecycle-mutation-lock');
const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
const {
  createWorkspaceSnapshot,
  transitionWorkspaceSnapshot,
} = await import('@/lib/worktree/snapshot-state');
const {
  withWorkspaceMaterializedMutation,
  WorkspaceMutationUnavailableError,
} = await import('./mutation-materialization-guard');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('parked workspace publication guard', () => {
  it('refuses merge and create_pr before Git or network can touch an unrelated occupant', async () => {
    const packetId = 'packet-parked-publish';
    const lane = createLane({
      repoPath,
      worktreePath: occupiedPath,
      branch: 'inline/parked-publish',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex:parked-publish',
    });
    let snapshot = createWorkspaceSnapshot({
      repositoryUuid,
      packetId,
      laneId: lane.id,
      originalPath: occupiedPath,
      branch: lane.branch,
      baseCommit: git(repoPath, 'rev-parse', 'HEAD'),
      headCommit: git(occupiedPath, 'rev-parse', 'HEAD'),
      treeSha: git(occupiedPath, 'rev-parse', 'HEAD^{tree}'),
      recoveryRef: 'refs/o8/recovery/parked-publish',
      diffFingerprint: 'parked-publish-diff',
      sessionIdentities: [{ kind: 'owned-session', identity: lane.sessionKey! }],
      creationId: 'parked-publish-created',
    }).record;
    for (const state of ['parkable', 'hibernating', 'parked'] as const) {
      const result = transitionWorkspaceSnapshot({
        repositoryUuid,
        packetId,
        transitionId: `parked-publish-${state}`,
        expectedState: snapshot.state,
        expectedVersion: snapshot.version,
        toState: state,
      });
      if (result.status !== 'applied') throw new Error(`Could not transition to ${state}.`);
      snapshot = result.record;
    }
    const repoHead = git(repoPath, 'rev-parse', 'HEAD');
    const occupantHead = git(occupiedPath, 'rev-parse', 'HEAD');
    const occupantBytes = readFileSync(path.join(occupiedPath, 'tracked.txt'), 'utf8');

    await expect(dispatch({ verb: 'merge', laneId: lane.id, actor: 'user' }))
      .resolves.toMatchObject({ ok: false, reason: 'workspace_restore_required' });
    await expect(dispatch({ verb: 'create_pr', laneId: lane.id, actor: 'user' }))
      .resolves.toMatchObject({ ok: false, reason: 'workspace_restore_required' });

    expect(git(repoPath, 'rev-parse', 'HEAD')).toBe(repoHead);
    expect(git(occupiedPath, 'rev-parse', 'HEAD')).toBe(occupantHead);
    expect(readFileSync(path.join(occupiedPath, 'tracked.txt'), 'utf8')).toBe(occupantBytes);
  });

  it('orders publication-first ahead of park and refuses publication when park starts first', async () => {
    const packetId = 'packet-publication-order';
    const workspacePath = path.join(root, 'publication-order-worktree');
    git(root, 'clone', repoPath, workspacePath);
    const lane = createLane({
      repoPath,
      worktreePath: workspacePath,
      branch: 'main',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex:publication-order',
    });
    const worktreeId = path.basename(workspacePath);
    const metadataPath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json');
    mkdirSync(path.dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, JSON.stringify({
      version: 1,
      worktrees: {
        [worktreeId]: {
          id: worktreeId,
          agentType: 'codex',
          baseBranch: 'main',
          createdAt: 1,
          claudeManaged: false,
          taskName: worktreeId,
          branchName: 'main',
          status: 'ready',
          isolationKind: 'apfs-cow-clone',
          materializationIdentity: {
            device: lstatSync(workspacePath).dev,
            inode: lstatSync(workspacePath).ino,
            canonicalPath: realpathSync(workspacePath),
          },
        },
      },
    }));
    let snapshot = createWorkspaceSnapshot({
      repositoryUuid,
      packetId,
      laneId: lane.id,
      originalPath: workspacePath,
      branch: lane.branch,
      baseCommit: git(repoPath, 'rev-parse', 'HEAD'),
      headCommit: git(workspacePath, 'rev-parse', 'HEAD'),
      treeSha: git(workspacePath, 'rev-parse', 'HEAD^{tree}'),
      recoveryRef: 'refs/o8/recovery/publication-order',
      diffFingerprint: 'publication-order-diff',
      sessionIdentities: [{ kind: 'owned-session', identity: lane.sessionKey! }],
      creationId: 'publication-order-created',
    }).record;

    let releasePublication!: () => void;
    let publicationEntered!: () => void;
    const publicationStarted = new Promise<void>((resolve) => { publicationEntered = resolve; });
    const publicationRelease = new Promise<void>((resolve) => { releasePublication = resolve; });
    const publication = withWorkspaceMaterializedMutation(lane, async () => {
      publicationEntered();
      await publicationRelease;
      return 'published';
    });
    await publicationStarted;
    const parkAfterPublication = withPacketLifecycleMutationLock(packetId, async ({ contended }) => contended);
    releasePublication();
    await expect(publication).resolves.toBe('published');
    await expect(parkAfterPublication).resolves.toBe(true);

    let releasePark!: () => void;
    let parkEntered!: () => void;
    const parkStarted = new Promise<void>((resolve) => { parkEntered = resolve; });
    const parkRelease = new Promise<void>((resolve) => { releasePark = resolve; });
    const parkFirst = withPacketLifecycleMutationLock(packetId, async () => {
      for (const state of ['parkable', 'hibernating', 'parked'] as const) {
        const result = transitionWorkspaceSnapshot({
          repositoryUuid,
          packetId,
          transitionId: `publication-order-${state}`,
          expectedState: snapshot.state,
          expectedVersion: snapshot.version,
          toState: state,
        });
        if (result.status !== 'applied') throw new Error(`Could not transition to ${state}.`);
        snapshot = result.record;
      }
      parkEntered();
      await parkRelease;
    });
    await parkStarted;
    let mutationStarted = false;
    const refusedPublication = withWorkspaceMaterializedMutation(lane, async () => {
      mutationStarted = true;
    });
    releasePark();
    await parkFirst;
    await expect(refusedPublication).rejects.toBeInstanceOf(WorkspaceMutationUnavailableError);
    expect(mutationStarted).toBe(false);
  });

  it('refuses merge and create_pr against a dirty same-HEAD inode replacement', async () => {
    const packetId = 'packet-publication-owner-swap';
    const workspacePath = path.join(root, 'publication-owner-swap');
    git(root, 'clone', repoPath, workspacePath);
    const lane = createLane({
      repoPath,
      worktreePath: workspacePath,
      branch: 'main',
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
      sessionKey: 'codex:publication-owner-swap',
    });
    const worktreeId = path.basename(workspacePath);
    const metadataPath = path.join(resolveWorktreeRootLayout(repoPath).primaryBase, '.meta.json');
    mkdirSync(path.dirname(metadataPath), { recursive: true });
    const materializationIdentity = {
      device: lstatSync(workspacePath).dev,
      inode: lstatSync(workspacePath).ino,
      canonicalPath: realpathSync(workspacePath),
    };
    writeFileSync(metadataPath, JSON.stringify({
      version: 1,
      worktrees: {
        [worktreeId]: {
          id: worktreeId, agentType: 'codex', baseBranch: 'main', createdAt: 1,
          claudeManaged: false, taskName: worktreeId, branchName: 'main', status: 'ready',
          isolationKind: 'apfs-cow-clone', materializationIdentity,
        },
      },
    }));
    const swapAfterProof = async (retainedPath: string) => {
      renameSync(workspacePath, retainedPath);
      git(root, 'clone', repoPath, workspacePath);
      writeFileSync(path.join(workspacePath, 'tracked.txt'), 'unrelated dirty bytes\n');
    };
    const retainedForMerge = path.join(root, 'publication-manager-owned-retained-merge');
    await expect(dispatch({ verb: 'merge', laneId: lane.id, actor: 'user' }, {
      afterWorkspaceMaterializationProof: () => swapAfterProof(retainedForMerge),
    })).resolves.toMatchObject({ ok: false });
    expect(readFileSync(path.join(workspacePath, 'tracked.txt'), 'utf8')).toBe('unrelated dirty bytes\n');
    expect(git(workspacePath, 'status', '--porcelain')).toContain('tracked.txt');
    expect(git(retainedForMerge, 'rev-parse', 'HEAD')).toBe(git(workspacePath, 'rev-parse', 'HEAD'));

    rmSync(workspacePath, { recursive: true });
    renameSync(retainedForMerge, workspacePath);
    const retainedForPr = path.join(root, 'publication-manager-owned-retained-pr');
    await expect(dispatch({ verb: 'create_pr', laneId: lane.id, actor: 'user' }, {
      afterWorkspaceMaterializationProof: () => swapAfterProof(retainedForPr),
    })).resolves.toMatchObject({ ok: false });
    expect(readFileSync(path.join(workspacePath, 'tracked.txt'), 'utf8')).toBe('unrelated dirty bytes\n');
    expect(git(workspacePath, 'status', '--porcelain')).toContain('tracked.txt');
    expect(git(retainedForPr, 'rev-parse', 'HEAD')).toBe(git(workspacePath, 'rev-parse', 'HEAD'));
  }, 20_000);
});
