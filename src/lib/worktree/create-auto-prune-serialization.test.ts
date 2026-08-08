import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env.O8_WORKTREE_ROOT;
  delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe('cold-start worktree maintenance serialization', () => {
  it('waits for auto-prune before mutating the shared Git worktree registry', async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-worktree-prune-create-')));
    roots.push(root);
    const repo = path.join(root, 'repo');
    const worktreeRoot = path.join(root, 'managed-worktrees');
    await mkdir(repo);
    await git(repo, ['init', '-b', 'main']);
    await writeFile(path.join(repo, 'README.md'), '# fixture\n');
    await git(repo, ['add', 'README.md']);
    await git(repo, ['commit', '-m', 'fixture']);
    process.env.O8_WORKTREE_ROOT = worktreeRoot;
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

    const { WorktreeManager } = await import('./manager');
    let releasePrune!: () => void;
    let reportPruneStarted!: () => void;
    const pruneStarted = new Promise<void>((resolve) => { reportPruneStarted = resolve; });
    const pruneBlocked = new Promise<void>((resolve) => { releasePrune = resolve; });
    vi.spyOn(WorktreeManager.prototype, 'prune').mockImplementation(async () => {
      reportPruneStarted();
      await pruneBlocked;
      return [];
    });

    const manager = new WorktreeManager(repo);
    let createSettled = false;
    const create = manager.create({
      agentType: 'codex',
      taskName: 'serialize maintenance',
      packetId: 'pkt-serialize-maintenance',
      branchName: 'inline/serialize-maintenance',
      baseBranch: 'main',
      managed: true,
      skipSetup: true,
      isolationPreference: 'git-worktree',
    }).finally(() => { createSettled = true; });

    await pruneStarted;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(createSettled).toBe(false);

    releasePrune();
    const created = await create;
    expect(existsSync(created.path)).toBe(true);
  }, 20_000);
});
