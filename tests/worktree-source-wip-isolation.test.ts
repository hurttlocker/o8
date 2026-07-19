import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/worktree/apfs', () => ({
  getApfsCowCapability: vi.fn(async (sourcePath: string, targetPath: string) => ({
    macos: true,
    apfs: true,
    sameVolume: true,
    canCowClone: true,
    sourceMount: sourcePath,
    targetMount: targetPath,
  })),
}));

const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

afterEach(() => {
  delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('fresh packet worktree source isolation', () => {
  it('does not carry tracked or untracked source WIP through the real dispatch worktree path', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-source-wip-isolation-'));
    tempDirs.push(repoPath);
    git(repoPath, ['init', '-q', '-b', 'main']);
    git(repoPath, ['config', 'user.email', 'test@o8.dev']);
    git(repoPath, ['config', 'user.name', 'o8 test']);
    writeFileSync(join(repoPath, 'tracked.txt'), 'committed\n');
    git(repoPath, ['add', 'tracked.txt']);
    git(repoPath, ['commit', '-q', '-m', 'base']);

    writeFileSync(join(repoPath, 'tracked.txt'), 'operator wip\n');
    writeFileSync(join(repoPath, 'untracked.txt'), 'operator untracked wip\n');
    process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

    const launch = await prepareLaunchWorktree({
      repoRoot: repoPath,
      agentType: 'codex',
      taskName: 'source WIP isolation',
      packetId: 'pkt-source-wip-isolation',
      branchName: 'inline/source-wip-isolation',
      baseBranch: 'main',
      isolate: true,
      skipSetup: true,
      isolationPreference: 'apfs-cow-clone',
    });

    expect(launch).not.toBeNull();
    expect(readFileSync(join(launch!.cwd, 'tracked.txt'), 'utf8')).toBe('committed\n');
    expect(existsSync(join(launch!.cwd, 'untracked.txt'))).toBe(false);
    expect(git(launch!.cwd, ['status', '--porcelain'])).toBe('');
  }, 30_000);
});
