import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';

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

vi.mock('@/lib/worktree/apfs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/apfs')>(),
  getApfsCowCapability: vi.fn(async () => ({
    macos: true,
    apfs: true,
    sameVolume: true,
    canCowClone: true,
  })),
}));

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-git-admin-boundary-')));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'worktrees');
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { closeDb } = await import('@/lib/db');
const { WorktreeManager } = await import('@/lib/worktree/manager');

function makeRepo(label: string): string {
  const repo = path.join(root, label);
  mkdirSync(repo);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  writeFileSync(path.join(repo, 'tracked.txt'), 'owned\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
  execFileSync('git', [
    '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test',
    'commit', '-q', '-m', 'owned',
  ], { cwd: repo });
  return repo;
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

// Managed hook injection is fail-closed: a workspace whose Git administration
// has been redirected out of its own repository is refused outright rather
// than having its exclusion written through the redirect. Both named refusals
// are the boundary firing - which one depends on whether the redirect is a
// gitdir file or a symlink.
const GIT_ADMIN_BOUNDARY_REFUSAL = new RegExp([
  '^Managed (?:',
  'worktree Git administration escaped its repository',
  '|Git administration path is not an exact directory',
  ')\\.$',
].join(''));

it.each(['git-worktree', 'apfs-cow-clone'] as const)(
  'refuses creation instead of writing through redirected %s Git administration',
  async (isolationKind) => {
    const repo = makeRepo(`repo-${isolationKind}`);
    const external = makeRepo(`external-${isolationKind}`);
    const externalExclude = path.join(external, '.git', 'info', 'exclude');
    writeFileSync(externalExclude, 'external-sentinel\n');
    const manager = new WorktreeManager(repo);
    Object.defineProperty(manager, 'bootstrapEnvFiles', {
      value: async (worktreePath: string) => {
        const gitPath = path.join(worktreePath, '.git');
        if (isolationKind === 'git-worktree') {
          writeFileSync(gitPath, `gitdir: ${path.join(external, '.git')}\n`);
        } else {
          renameSync(gitPath, `${gitPath}-admitted`);
          symlinkSync(path.join(external, '.git'), gitPath, 'dir');
        }
      },
    });
    Object.defineProperty(manager, 'resetTrackedWorkspaceChanges', {
      value: async () => {},
    });

    await expect(manager.create({
      agentType: 'codex',
      taskName: `admin-${isolationKind}`,
      baseBranch: 'main',
      branchName: `inline/admin-${isolationKind}`,
      managed: true,
      skipSetup: true,
      isolationPreference: isolationKind,
    })).rejects.toThrow(GIT_ADMIN_BOUNDARY_REFUSAL);

    expect(readFileSync(externalExclude, 'utf8')).toBe('external-sentinel\n');
    // The exclusion the injector would have written lands in the common
    // directory's info/, so the external repository must have gained nothing.
    expect(readdirSync(path.join(external, '.git', 'info'))).toEqual(['exclude']);
  },
  30_000,
);
