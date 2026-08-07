import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
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

/**
 * The pre-launch typecheck gate (#1107) must SKIP quietly when there is nothing
 * to check, and must never mistake a missing tool for a broken base branch —
 * that misdiagnosis blocked every non-TypeScript repo and, on Windows, every
 * repo at all (#1762). The sibling test above covers the other half: when a
 * tsconfig and a repo-local tsc DO exist, the gate resolves and runs, with
 * node_modules linked first.
 */
describe('prelaunch typecheck skip', () => {
  it('creates the worktree when the repo has no TypeScript at all', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'o8-prelaunch-skip-'));
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    await execFileAsync('git', ['init', '--bare', origin]);
    await execFileAsync('git', ['clone', origin, repo]);
    await git(repo, ['checkout', '-b', 'main']);
    // No tsconfig.json and no node_modules/.bin/tsc — the shape that used to
    // raise ENOENT and get reported as "main HEAD is in an inconsistent state".
    await writeFile(path.join(repo, 'README.md'), '# fixture\n');
    await git(repo, ['add', 'README.md']);
    await git(repo, ['commit', '-m', 'fixture']);
    await git(repo, ['push', '-u', 'origin', 'main']);

    const manager = new WorktreeManager(repo);
    const worktree = await manager.create({
      agentType: 'codex',
      taskName: 'no typescript in this repo',
    });

    expect(worktree.path).toBeTruthy();
    const stat = await lstat(worktree.path);
    expect(stat.isDirectory()).toBe(true);
  }, 60_000);
});

/**
 * Regression guard for a host-data-destroying bug that appeared TWICE while
 * hardening this path for Windows.
 *
 * A worktree's node_modules is a SYMLINK to the host repo's. If anything
 * decides that link is "unhealthy" and falls through to an install, npm's
 * removal step (readdir + rm per entry) runs THROUGH the link and empties the
 * host's tree. The health check that triggered it exists for a real directory
 * left behind by a killed install — applying it to a link destroys the thing
 * it is inspecting.
 */
describe('a symlinked node_modules is never treated as unhealthy', () => {
  it('returns early instead of installing when the link is already in place', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'o8-nm-link-'));
    roots.push(root);
    const origin = path.join(root, 'origin.git');
    const repo = path.join(root, 'repo');
    await execFileAsync('git', ['init', '--bare', origin]);
    await execFileAsync('git', ['clone', origin, repo]);
    await git(repo, ['checkout', '-b', 'main']);
    await writeFile(path.join(repo, 'package.json'), '{"name":"fixture","private":true}\n');
    await writeFile(path.join(repo, 'package-lock.json'), '{"name":"fixture","lockfileVersion":3}\n');
    await git(repo, ['add', 'package.json', 'package-lock.json']);
    await git(repo, ['commit', '-m', 'fixture']);
    await git(repo, ['push', '-u', 'origin', 'main']);

    // Host deps with NEITHER health marker — the state that made the guard
    // report "unhealthy" and fall through to an install.
    const hostModules = path.join(repo, 'node_modules');
    await mkdir(path.join(hostModules, 'left-pad'), { recursive: true });
    const sentinel = path.join(hostModules, 'left-pad', 'index.js');
    await writeFile(sentinel, 'module.exports = 1;\n');

    const manager = new WorktreeManager(repo);
    const worktree = await manager.create({
      agentType: 'codex',
      taskName: 'symlinked node_modules must survive',
    });

    // Put the link in place FIRST, exactly as the APFS-CoW path does before
    // runSetup — this is what the earlier version of this test never did, so it
    // exercised the happy path and would have passed with the guard deleted.
    const worktreeModules = path.join(worktree.path, 'node_modules');
    await rm(worktreeModules, { recursive: true, force: true }).catch(() => {});
    await symlink(hostModules, worktreeModules);

    // An install here would readdir+rm THROUGH the link and empty the host.
    // Drive the real entry point rather than the private helper.
    await (manager as unknown as { runSetup(p: string): Promise<void> }).runSetup(worktree.path);

    expect(await lstat(sentinel).then(() => true).catch(() => false)).toBe(true);
    expect((await lstat(worktreeModules)).isSymbolicLink()).toBe(true);
  }, 120_000);
});
