import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureWorktreeState } from './worktree-capture';

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(withCommit = true): string {
  const repo = mkdtempSync(join(tmpdir(), 'o8-capture-test-'));
  tempDirs.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@o8.dev']);
  git(repo, ['config', 'user.name', 'o8 test']);
  if (withCommit) {
    writeFileSync(join(repo, 'tracked.ts'), 'export const x = 1;\n');
    git(repo, ['add', 'tracked.ts']);
    git(repo, ['commit', '-q', '-m', 'base']);
  }
  return repo;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('captureWorktreeState', () => {
  it('snapshots tracked modifications AND untracked files to an out-of-band ref', async () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'tracked.ts'), 'export const x = 2;\n'); // modify tracked
    writeFileSync(join(repo, 'untracked.ts'), 'export const y = 3;\n'); // new untracked

    const result = await captureWorktreeState(repo, 'lane-abc');

    expect(result.captured).toBe(true);
    expect(result.ref).toBe('refs/o8-capture/lane-abc');
    expect(result.sha).toBeTruthy();

    // ref resolves to the snapshot commit
    expect(git(repo, ['rev-parse', result.ref!])).toBe(result.sha);

    // the snapshot contains both the modified tracked file and the untracked one
    const files = git(repo, ['ls-tree', '-r', '--name-only', result.sha!]).split('\n');
    expect(files).toContain('tracked.ts');
    expect(files).toContain('untracked.ts');
    expect(git(repo, ['show', `${result.sha}:tracked.ts`])).toContain('export const x = 2;');
    expect(git(repo, ['show', `${result.sha}:untracked.ts`])).toContain('export const y = 3;');
  });

  it('does not touch the working tree, real index, or stash stack', async () => {
    const repo = initRepo();
    writeFileSync(join(repo, 'tracked.ts'), 'export const x = 2;\n');
    writeFileSync(join(repo, 'untracked.ts'), 'export const y = 3;\n');
    const statusBefore = git(repo, ['status', '--porcelain']);

    await captureWorktreeState(repo, 'lane-abc');

    // working tree + index unchanged (add -A went to a throwaway index)
    expect(git(repo, ['status', '--porcelain'])).toBe(statusBefore);
    // stash stack untouched
    expect(git(repo, ['stash', 'list'])).toBe('');
  });

  it('returns captured:false and creates no ref for a clean worktree', async () => {
    const repo = initRepo();
    const result = await captureWorktreeState(repo, 'lane-clean');
    expect(result.captured).toBe(false);
    expect(result.ref).toBeUndefined();
    expect(() => git(repo, ['rev-parse', 'refs/o8-capture/lane-clean'])).toThrow();
  });

  it('captures as a root commit when the repo has no HEAD yet', async () => {
    const repo = initRepo(false); // no commits
    writeFileSync(join(repo, 'wip.ts'), 'export const z = 4;\n');

    const result = await captureWorktreeState(repo, 'lane-fresh');

    expect(result.captured).toBe(true);
    // no parents on a root capture
    expect(git(repo, ['rev-list', '--count', result.sha!])).toBe('1');
  });

  it('is a no-op for a missing worktree path', async () => {
    expect(await captureWorktreeState(null, 'lane-x')).toEqual({ captured: false });
    expect(await captureWorktreeState('   ', 'lane-x')).toEqual({ captured: false });
  });
});
