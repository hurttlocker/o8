import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { WorktreeManager } from './manager';
import { resolveWorktreeRootLayout } from './root-layout';

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

async function git(args: string[], cwd: string) {
  return execFileAsync('git', args, {
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

async function initRepo(prefix: string) {
  const repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  cleanupPaths.push(repoRoot);
  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(path.join(repoRoot, 'seed.txt'), 'seed\n', 'utf8');
  await git(['add', 'seed.txt'], repoRoot);
  await git(['commit', '-m', 'seed'], repoRoot);
  return repoRoot;
}

afterEach(async () => {
  for (const cleanupPath of cleanupPaths.splice(0)) {
    await rm(cleanupPath, { recursive: true, force: true });
  }
  delete process.env.CORTEX_IDE_DATA_DIR;
  delete process.env.O8_WORKTREE_ROOT;
  delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
});

describe('external worktree root layout (#1594)', () => {
  it('honors the explicit worktree-root override', async () => {
    const repoRoot = await initRepo('o8-worktree-root-env-');
    const overrideRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-worktree-root-override-')));
    cleanupPaths.push(overrideRoot);
    process.env.O8_WORKTREE_ROOT = overrideRoot;

    expect(resolveWorktreeRootLayout(repoRoot).primaryBase)
      .toBe(path.join(overrideRoot, resolveWorktreeRootLayout(repoRoot).repoKey, '.cortex-worktrees'));
  });

  it('creates outside the repo in a per-repo directory and still lists legacy worktrees', async () => {
    const dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-worktree-data-')));
    cleanupPaths.push(dataDir);
    process.env.CORTEX_IDE_DATA_DIR = dataDir;
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
    const repoRoot = await initRepo('o8-worktree-root-a-');
    const otherRepoRoot = await initRepo('o8-worktree-root-b-');
    const layout = resolveWorktreeRootLayout(repoRoot);
    const otherLayout = resolveWorktreeRootLayout(otherRepoRoot);

    expect(layout.primaryBase.startsWith(`${repoRoot}${path.sep}`)).toBe(false);
    expect(layout.primaryBase).toContain(path.join(dataDir, 'worktrees', layout.repoKey));
    expect(otherLayout.repoKey).not.toBe(layout.repoKey);
    expect(otherLayout.primaryBase).not.toBe(layout.primaryBase);

    const manager = new WorktreeManager(repoRoot);
    const created = await manager.create({
      agentType: 'codex',
      taskName: 'external root',
      packetId: 'pkt-external-root',
      branchName: 'issue/external-root',
      baseBranch: 'main',
      managed: true,
      skipSetup: true,
      isolationPreference: 'git-worktree',
    });
    expect(created.path.startsWith(`${repoRoot}${path.sep}`)).toBe(false);
    expect(created.path.startsWith(`${layout.primaryBase}${path.sep}`)).toBe(true);

    const legacyPath = path.join(layout.legacyBase, 'packet-legacy');
    await git(['worktree', 'add', legacyPath, '-b', 'worktree/codex/legacy'], repoRoot);
    await mkdir(layout.legacyBase, { recursive: true });
    await writeFile(path.join(layout.legacyBase, '.meta.json'), JSON.stringify({
      version: 1,
      worktrees: {
        'packet-legacy': {
          id: 'packet-legacy',
          agentType: 'codex',
          baseBranch: 'main',
          createdAt: Date.now(),
          claudeManaged: false,
          taskName: 'legacy packet',
          branchName: 'worktree/codex/legacy',
          status: 'ready',
          isolationKind: 'git-worktree',
        },
      },
    }), 'utf8');
    const listed = await manager.list();

    expect(listed.find((worktree) => worktree.id === created.id)?.path).toBe(created.path);
    expect(listed.find((worktree) => worktree.id === 'packet-legacy')?.path).toBe(legacyPath);
  }, 60_000);
});
