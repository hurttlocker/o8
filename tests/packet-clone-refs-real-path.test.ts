import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, expect, it, vi } from 'vitest';

// Only the capability gate is replaced: clone, checkout, refs, persisted lane
// ownership and retirement all use their real implementations on Linux.
vi.mock('@/lib/worktree/apfs', async (original) => ({
  ...await original<typeof import('@/lib/worktree/apfs')>(),
  getApfsCowCapability: async () => ({ macos: true, apfs: true, sameVolume: true, canCowClone: true }),
}));
vi.mock('@/lib/lane/terminal-lane-cleanup', () => ({ scheduleTerminalLaneCleanup: vi.fn() }));

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'o8-packet-clone-refs-')));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = path.join(root, 'workspaces');

const { closeDb } = await import('@/lib/db');
const { createLane, updateLane, setLaneStatus } = await import('@/lib/lane/registry');
const { addRepo } = await import('@/lib/repos/registry');
const { WorktreeManager } = await import('@/lib/worktree/manager');
const { getWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

afterAll(() => {
  closeDb();
  rmSync(root, { recursive: true, force: true });
});

it.each(['pinned', 'legacy', 'local-only', 'worker-commit'] as const)(
  'provisions and retires a %s packet without inheriting operator branch ownership',
  async (mode) => {
    const repoPath = path.join(root, mode);
    mkdirSync(repoPath);
    git(repoPath, 'init', '-q', '-b', 'main');
    git(repoPath, 'config', 'user.name', 'o8-test');
    git(repoPath, 'config', 'user.email', 'o8@example.test');
    // Keep generated hook configuration ignored after retirement relocates .git.
    writeFileSync(path.join(repoPath, '.gitignore'), '.claude/settings.local.json\n.o8/\n');
    writeFileSync(path.join(repoPath, 'base.txt'), 'base\n');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-qm', 'base');
    const remoteBase = git(repoPath, 'rev-parse', 'HEAD');
    const origin = path.join(root, mode + '-origin.git');
    if (mode !== 'local-only') {
      git(root, 'init', '-q', '--bare', origin);
      git(repoPath, 'remote', 'add', 'origin', origin);
      git(repoPath, 'push', '-u', 'origin', 'main');
    }
    writeFileSync(path.join(repoPath, 'operator-only.txt'), 'local source\n');
    git(repoPath, 'add', '.');
    git(repoPath, 'commit', '-qm', 'local source');
    const localMain = git(repoPath, 'rev-parse', 'HEAD');
    git(repoPath, 'branch', 'unpublished-work');
    if (mode === 'pinned') git(repoPath, 'checkout', '-q', 'unpublished-work');
    const sourceRefs = git(repoPath, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes');
    const repo = await addRepo(repoPath);
    const packetId = 'clone-refs-' + mode;
    const branch = 'inline/' + packetId;
    const lane = createLane({ repoPath, branch, baseBranch: 'main', runtime: 'codex', packetId,
      ownership: 'managed', ...(['pinned', 'worker-commit'].includes(mode) ? { baseCommit: remoteBase } : {}) });
    const manager = new WorktreeManager(repoPath);
    const worktree = await manager.create({ agentType: 'codex', taskName: packetId, branchName: branch,
      baseBranch: 'main', packetId, laneId: lane.id, skipSetup: true, envMode: 'skip',
      isolationPreference: 'apfs-cow-clone' });
    updateLane(lane.id, { worktreePath: worktree.path });

    expect(git(worktree.path, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe('refs/heads/' + branch + '\nrefs/heads/main');
    expect(git(worktree.path, 'rev-parse', 'refs/heads/main')).toBe(mode === 'local-only' ? localMain : remoteBase);
    const pinned = ['pinned', 'worker-commit'].includes(mode);
    expect(git(worktree.path, 'rev-parse', 'HEAD')).toBe(pinned ? remoteBase : localMain);
    expect(existsSync(path.join(worktree.path, 'operator-only.txt'))).toBe(!pinned);
    if (mode !== 'local-only') {
      expect(git(worktree.path, 'show-ref', '--verify', '--hash', 'refs/remotes/origin/main')).toBe(remoteBase);
      expect(git(worktree.path, 'for-each-ref', '--format=%(refname)', 'refs/remotes')).toBe('refs/remotes/origin/main');
      expect(git(worktree.path, 'remote', 'get-url', 'origin')).toBe(origin);
    } else {
      expect(git(worktree.path, 'remote')).toBe('');
    }
    if (pinned) expect(git(worktree.path, 'rev-list', '--all').split('\n')).not.toContain(localMain);

    let workerHead: string | null = null;
    if (mode === 'worker-commit') {
      writeFileSync(path.join(worktree.path, 'worker.txt'), 'unique worker source\n');
      git(worktree.path, 'add', 'worker.txt');
      git(worktree.path, '-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-qm', 'worker source');
      workerHead = git(worktree.path, 'rev-parse', 'HEAD');
      expect(await manager.getDirtyFiles(worktree.path, 'main')).toContain('worker.txt');
    }

    setLaneStatus(lane.id, 'archived');
    expect(await manager.cleanup(worktree.id, { force: true, deleteBranch: true })).toBe(true);
    expect(existsSync(worktree.path)).toBe(false);
    expect(getWorkspaceSnapshot(repo.id, packetId)?.state).toBe('retired');
    if (workerHead) {
      expect(git(repoPath, 'rev-parse', 'refs/heads/preserved/' + worktree.id)).toBe(workerHead);
      expect(git(repoPath, 'show', workerHead + ':worker.txt')).toBe('unique worker source');
    } else {
      expect(git(repoPath, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes')).toBe(sourceRefs);
    }
    expect(git(repoPath, 'rev-parse', 'main')).toBe(localMain);
    expect(readFileSync(path.join(repoPath, 'operator-only.txt'), 'utf8')).toBe('local source\n');
  },
  120_000,
);
