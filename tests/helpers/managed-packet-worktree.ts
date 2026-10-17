import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Bind an idle owned Codex session to a manager-created packet worktree, the
 * owner evidence stop, reset and terminal cleanup require before removing it.
 * Give the packet lane the returned `sessionKey`. Import after the test has set
 * its data-directory environment.
 */
export async function bindOwnedPacketSession(repoPath: string, worktree: { id: string; path: string }, input: {
  packetId: string;
  branch: string;
}) {
  const { getDataDir } = await import('@/lib/data-dir-migration');
  const { addRepo, findRepoByLocalPath } = await import('@/lib/repos/registry');
  const { getWorktreeManager } = await import('@/lib/worktree/launch');
  const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
  const repo = await findRepoByLocalPath(repoPath) ?? await addRepo(repoPath);
  const sessionKey = `codex-owned:codex-owned-${input.packetId}`;
  const ownedRoot = process.env.CORTEX_IDE_OWNED_CODEX_ROOT || join(getDataDir(), 'owned-codex');
  process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
  const sessionDir = join(ownedRoot, `codex-owned-${input.packetId}`);
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree.path, encoding: 'utf8' }).trim();
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId: sessionKey, packetId: input.packetId, sessionDir, cwd: worktree.path, repoPath: worktree.path,
    branch: input.branch, head, title: 'Packet worktree fixture', createdAt: now, updatedAt: now, recentRuns: [],
    latestPrompt: 'Packet worktree fixture.', latestSummary: 'Idle.',
    runIdentityLedger: { version: 1, totalRuns: 0, complete: true },
    workspaceBinding: {
      logicalWorkspaceId: `packet:${input.packetId}`, repositoryUuid: repo.id, packetId: input.packetId,
      cwd: worktree.path, version: 1, verifiedAt: now,
    },
  }), { mode: 0o600 });
  resetOwnedSessionIndex();
  await getWorktreeManager(repoPath).linkSession(worktree.id, sessionKey);
  return sessionKey;
}

/**
 * A packet worktree o8 owns: created by the worktree manager with an owned
 * session bound to it. Cleanup refuses a raw `git worktree add` or clone path.
 */
export async function createManagedPacketWorktree(repoPath: string, input: {
  packetId: string;
  branch: string;
  baseBranch?: string;
}) {
  const { getWorktreeManager } = await import('@/lib/worktree/launch');
  const worktree = await getWorktreeManager(repoPath).create({
    agentType: 'codex',
    taskName: input.packetId,
    branchName: input.branch,
    baseBranch: input.baseBranch ?? 'main',
    packetId: input.packetId,
    skipSetup: true,
    isolationPreference: 'git-worktree',
  });
  const sessionKey = await bindOwnedPacketSession(repoPath, worktree, input);
  return { id: worktree.id, path: worktree.path, sessionKey };
}
