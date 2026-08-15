import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/worktree/storage-telemetry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({
    accountingStatus: 'observed' as const,
    probePath: '/',
    availableBytes: 90_000_000_000,
    freeBytes: 90_000_000_000,
    totalBytes: 100_000_000_000,
    error: null,
  })),
}));

describe('direct managed worktree admission', () => {
  it('reserves and commits through the real manager chokepoint without a scheduler proof', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'o8-direct-manager-admission-repo-'));
    process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-direct-manager-admission-root-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-q', '-m', 'base'], { cwd: repo });
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const { getSqlite } = await import('@/lib/db');

    const created = await new WorktreeManager(repo).create({
      agentType: 'codex',
      taskName: 'direct admission',
      branchName: `inline/direct-admission-${Date.now()}`,
      baseBranch: 'main',
      skipSetup: true,
    });

    expect(created.path).toContain(process.env.O8_WORKTREE_ROOT);
    expect(getSqlite().prepare(`
      SELECT state FROM storage_admission_reservations
      WHERE owner_id LIKE 'managed-worktree-process:%'
      ORDER BY created_at DESC LIMIT 1
    `).get()).toEqual({ state: 'committed' });
  }, 45_000);

  it('does not reuse an id held by an unresolved trusted retirement claim', async () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'o8-retirement-collision-repo-'));
    process.env.O8_WORKTREE_ROOT = mkdtempSync(path.join(os.tmpdir(), 'o8-retirement-collision-root-'));
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    writeFileSync(path.join(repo, 'README.md'), 'base\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repo });
    execFileSync('git', [
      '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
      'commit', '-q', '-m', 'base',
    ], { cwd: repo });
    const { WorktreeManager } = await import('@/lib/worktree/manager');
    const { resolveWorktreeRootLayout } = await import('@/lib/worktree/root-layout');
    const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
    const { retireExactManagedDirectory } = await import('@/lib/workspace/exact-managed-directory-retirement');
    const { readExactWorkspaceClaim } = await import('@/lib/workspace/exact-workspace-claim-state');
    const manager = new WorktreeManager(repo);

    await manager.create({
      agentType: 'codex',
      taskName: 'prime prune cooldown',
      baseBranch: 'main',
      skipSetup: true,
    });
    const pendingId = `pending-retirement-${Date.now()}`;
    const base = resolveWorktreeRootLayout(repo).primaryBase;
    const pendingPath = path.join(base, pendingId);
    mkdirSync(pendingPath);
    await retireExactManagedDirectory({
      repositoryPath: repo,
      worktreeId: pendingId,
      directoryPath: pendingPath,
      identity: await captureWorktreeMaterializationIdentity(pendingPath),
      parentIdentity: await captureWorktreeMaterializationIdentity(base),
    });
    expect(readExactWorkspaceClaim('managed-retirement', repo, pendingId)?.state)
      .toBe('purging');

    const created = await manager.create({
      agentType: 'codex',
      taskName: pendingId,
      baseBranch: 'main',
      skipSetup: true,
    });

    expect(created.id).not.toBe(pendingId);
    expect(created.path).not.toBe(pendingPath);
    expect(readExactWorkspaceClaim('managed-retirement', repo, pendingId)?.state)
      .toBe('purging');
  }, 30_000);
});
