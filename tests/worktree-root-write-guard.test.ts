import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

process.env.CORTEX_IDE_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR
  ?? mkdtempSync(join(tmpdir(), 'o8-root-guard-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;

const { getWorktreeManager } = await import('@/lib/worktree/launch');
const { removeCortexWorktreePath } = await import('@/lib/lane/worktree-clone-removal');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function makeDirtyRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'o8-root-guard-repo-'));
  git(repoPath, ['init', '-b', 'main']);
  writeFileSync(join(repoPath, 'tracked.txt'), 'base\n');
  git(repoPath, ['add', 'tracked.txt']);
  git(repoPath, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@test.local', 'commit', '-m', 'base']);
  // Operator WIP the guard must never commit.
  writeFileSync(join(repoPath, 'tracked.txt'), 'operator wip\n');
  mkdirSync(join(repoPath, '.cortex-worktrees'), { recursive: true });
  return repoPath;
}

describe('repo-root write guard (#1404) — lane lifecycle git writes never target a repo root', () => {
  it('manager.cleanup with a blank worktreeId refuses instead of committing operator WIP at the root', async () => {
    const repoPath = makeDirtyRepo();
    const headBefore = git(repoPath, ['rev-parse', 'HEAD']).trim();

    const manager = getWorktreeManager(repoPath);
    await manager.cleanup('', { force: true });

    expect(git(repoPath, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(git(repoPath, ['status', '--porcelain'])).toContain('tracked.txt');
  });

  it('manager.cleanup with a traversal worktreeId refuses', async () => {
    const repoPath = makeDirtyRepo();
    const headBefore = git(repoPath, ['rev-parse', 'HEAD']).trim();

    const manager = getWorktreeManager(repoPath);
    await manager.cleanup('..', { force: true });
    await manager.cleanup('../..', { force: true });

    expect(git(repoPath, ['rev-parse', 'HEAD']).trim()).toBe(headBefore);
    expect(git(repoPath, ['status', '--porcelain'])).toContain('tracked.txt');
  });

  it('removeCortexWorktreePath refuses a target equal to the repo root (and empty paths)', async () => {
    const repoPath = makeDirtyRepo();

    expect(await removeCortexWorktreePath({ repoRoot: repoPath, worktreePath: repoPath })).toBe(false);
    expect(await removeCortexWorktreePath({ repoRoot: repoPath, worktreePath: '  ' })).toBe(false);
    // The repo (and the operator's WIP) survives untouched.
    expect(git(repoPath, ['status', '--porcelain'])).toContain('tracked.txt');
  });
});
