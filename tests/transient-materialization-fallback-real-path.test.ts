import { execFileSync } from 'node:child_process';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const root = mkdtempSync(path.join(os.tmpdir(), 'o8-transient-materialization-'));
const dataDir = path.join(root, 'data');
const repoPath = path.join(root, 'transient-repo');
const worktreeRoot = path.join(root, 'worktrees');
const previousDataDir = process.env.CORTEX_IDE_DATA_DIR;
const previousO8DataDir = process.env.O8_DATA_DIR;
const previousWorktreeRoot = process.env.O8_WORKTREE_ROOT;

process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = worktreeRoot;
mkdirSync(dataDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
mkdirSync(worktreeRoot, { recursive: true });

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

git(repoPath, 'init', '-q', '-b', 'main');
writeFileSync(path.join(repoPath, 'README.md'), 'transient fixture\n');
git(repoPath, 'add', 'README.md');
git(repoPath, '-c', 'user.name=o8-test', '-c', 'user.email=test@invalid', 'commit', '-qm', 'fixture');

const [
  { closeDb },
  { createLane, setLaneStatus },
  { inspectOwnedWorkspaceMaterialization },
  { withWorktreeMetaTransaction },
  { isManagedPacketWorktreeId, managedPacketWorktreeId, resolveWorktreeRootLayout },
] = await Promise.all([
  import('@/lib/db'),
  import('@/lib/lane/registry'),
  import('@/lib/workspace/materialization-guard'),
  import('@/lib/worktree/metadata-store'),
  import('@/lib/worktree/root-layout'),
]);

afterAll(() => {
  closeDb();
  if (previousDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = previousDataDir;
  if (previousO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = previousO8DataDir;
  if (previousWorktreeRoot === undefined) delete process.env.O8_WORKTREE_ROOT;
  else process.env.O8_WORKTREE_ROOT = previousWorktreeRoot;
  rmSync(root, { recursive: true, force: true });
});

describe.sequential('transient materialization fallback through persisted lane truth', () => {
  it('uses the default dependencies for an active lane and refuses it after terminal failure', async () => {
    const packetId = 'pkt-default-dependency-fallback';
    const baseId = managedPacketWorktreeId(packetId);
    if (!baseId) throw new Error('Expected a managed packet worktree id.');
    const worktreeId = `${baseId}-a1b2`;
    const branch = 'inline/default-dependency-fallback';
    const layout = resolveWorktreeRootLayout(repoPath);
    const worktreePath = path.join(layout.primaryBase, worktreeId);
    mkdirSync(layout.primaryBase, { recursive: true });
    git(repoPath, 'worktree', 'add', '-q', '-b', branch, worktreePath, 'main');

    const materialized = lstatSync(worktreePath);
    const parent = lstatSync(path.dirname(worktreePath));
    const materializationIdentity = {
      device: materialized.dev,
      inode: materialized.ino,
      canonicalPath: realpathSync.native(worktreePath),
    };
    await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
      id: worktreeId,
      agentType: 'codex',
      baseBranch: 'main',
      createdAt: Date.now(),
      claudeManaged: false,
      taskName: worktreeId,
      branchName: branch,
      status: 'ready',
      isolationKind: 'git-worktree',
      materializationIdentity,
      materializationParentIdentity: {
        device: parent.dev,
        inode: parent.ino,
        canonicalPath: realpathSync.native(path.dirname(worktreePath)),
      },
    }));
    const lane = createLane({
      repoPath,
      worktreePath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
      packetId,
    });
    const input = {
      surfaceId: `codex-owned:${packetId}`,
      sessionPacketId: packetId,
      laneId: lane.id,
      runtimeId: 'codex',
      mode: 'launch' as const,
      binding: {
        logicalWorkspaceId: `packet:${packetId}`,
        repositoryUuid: null,
        packetId,
        cwd: worktreePath,
        version: 1 as const,
        verifiedAt: '2026-09-04T00:00:00.000Z',
      },
      repoPath: worktreePath,
    };

    expect(isManagedPacketWorktreeId(worktreeId, packetId)).toBe(true);
    await expect(inspectOwnedWorkspaceMaterialization(input)).resolves.toEqual({
      status: 'available',
      source: 'materialized',
      materializationIdentity,
    });

    setLaneStatus(lane.id, 'failed', 'system', 'fixture_terminal');
    await expect(inspectOwnedWorkspaceMaterialization(input)).resolves.toMatchObject({
      status: 'unknown',
    });
  }, 30_000);
});
