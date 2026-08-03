import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from './manager';

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, args: string[]) {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'o8 test',
      GIT_AUTHOR_EMAIL: 'test@o8.local',
      GIT_COMMITTER_NAME: 'o8 test',
      GIT_COMMITTER_EMAIL: 'test@o8.local',
    },
  });
}

afterEach(async () => {
  delete process.env.O8_WORKTREE_ROOT;
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe('prelaunch dependency resolution', () => {
  it('links matching repo dependencies into an external managed worktree before typecheck', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'o8-prelaunch-deps-'));
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    const externalRoot = path.join(root, 'managed-worktrees');
    await execFileAsync('git', ['init', '--bare', origin]);
    await execFileAsync('git', ['clone', origin, repo]);
    await git(repo, ['checkout', '-b', 'main']);
    await writeFile(path.join(repo, 'package.json'), '{"name":"fixture","private":true}\n');
    await writeFile(path.join(repo, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3}\n');
    await writeFile(path.join(repo, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}\n');
    const binDir = path.join(repo, 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    const tscPath = path.join(binDir, 'tsc');
    await writeFile(tscPath, '#!/bin/sh\ntest -L "$PWD/node_modules"\n');
    await chmod(tscPath, 0o755);
    await git(repo, ['add', 'package.json', 'package-lock.json', 'tsconfig.json']);
    await git(repo, ['commit', '-m', 'fixture']);
    await git(repo, ['push', '-u', 'origin', 'main']);

    process.env.O8_WORKTREE_ROOT = externalRoot;
    const manager = new WorktreeManager(repo);
    const worktree = await manager.create({
      agentType: 'codex',
      taskName: 'external dependency resolution',
      branchName: 'worktree/codex/external-dependency-resolution',
      baseBranch: 'main',
      skipSetup: true,
    });

    const linkedPath = path.join(worktree.path, 'node_modules');
    expect((await lstat(linkedPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(linkedPath)).toBe(path.join(repo, 'node_modules'));
    expect(path.dirname(worktree.path)).not.toBe(path.dirname(repo));
  }, 30_000);
});
