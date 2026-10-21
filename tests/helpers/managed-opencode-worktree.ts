import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A packet worktree o8 owns, as close and reset require before removing one: a
 * registered repo, a managed worktree record under the worktree root, and an
 * idle owned OpenCode session the lane names. `ownedRoot` must be the
 * `O8_OWNED_OPENCODE_ROOT` the test set before importing o8 modules.
 */
export async function createManagedOpenCodeWorktree(input: {
  parent: string;
  prefix: string;
  branch: string;
  packetId: string;
  ownedRoot: string;
}) {
  const { addRepo } = await import('@/lib/repos/registry');
  const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
  const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
  const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();

  const root = mkdtempSync(join(input.parent, input.prefix));
  const repoPath = join(root, 'repo');
  git(root, 'init', '--initial-branch=main', repoPath);
  git(repoPath, '-c', 'user.email=test@o8.test', '-c', 'user.name=o8-test', 'commit', '--allow-empty', '-m', 'init');
  const worktreeId = `packet-${input.packetId}`;
  const worktreePath = join(resolveWorktreeRootLayout(repoPath).primaryBase, worktreeId);
  mkdirSync(join(worktreePath, '..'), { recursive: true });
  git(repoPath, 'worktree', 'add', '-b', input.branch, worktreePath);
  const repo = await addRepo(repoPath);

  const sessionKey = `opencode-owned:opencode-owned-${input.packetId}`;
  const sessionDir = join(input.ownedRoot, `opencode-owned-${input.packetId}`);
  mkdirSync(sessionDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId: sessionKey, packetId: input.packetId, sessionDir, cwd: worktreePath, repoPath: worktreePath,
    branch: input.branch, head: git(worktreePath, 'rev-parse', 'HEAD'), title: 'OpenCode lifecycle fixture',
    createdAt: now, updatedAt: now, recentRuns: [], latestPrompt: 'Lifecycle fixture.', latestSummary: 'Idle.',
    runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
    workspaceBinding: {
      logicalWorkspaceId: `packet:${input.packetId}`, repositoryUuid: repo.id, packetId: input.packetId,
      cwd: worktreePath, version: 1, verifiedAt: now,
    },
  }));

  const [materializationIdentity, materializationParentIdentity] = await Promise.all([
    captureWorktreeMaterializationIdentity(worktreePath),
    captureWorktreeMaterializationIdentity(join(worktreePath, '..')),
  ]);
  await withWorktreeMetaTransaction(repoPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId, agentType: 'opencode', sessionKey, baseBranch: 'main', createdAt: Date.now(), claudeManaged: false,
    taskName: input.packetId, branchName: input.branch, status: 'ready', isolationKind: 'git-worktree',
    materializationIdentity, materializationParentIdentity,
  }));
  return { root, repoPath, worktreePath, sessionKey };
}
