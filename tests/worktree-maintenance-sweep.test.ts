/**
 * Real maintenance-tick proof for fleet-wide terminal worktree cleanup.
 *
 * The app can run outside the repo it is operating on, so the periodic entry
 * point must cover both saved repos and transient repos known only by a lane.
 */
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];
let dataDir: string;

async function git(cwd: string, args: string[]) {
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

async function makeRepo(label: string) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), `o8-maintenance-${label}-`));
  cleanupPaths.push(repoRoot);
  await git(repoRoot, ['init', '-b', 'main']);
  await writeFile(path.join(repoRoot, 'seed.txt'), 'seed\n', 'utf8');
  await git(repoRoot, ['add', 'seed.txt']);
  await git(repoRoot, ['commit', '-m', 'seed']);
  return repoRoot;
}

async function makeWorktree(repoRoot: string, packetId: string) {
  const worktreeBase = path.join(repoRoot, '.cortex-worktrees');
  const worktreePath = path.join(worktreeBase, `packet-${packetId}`);
  await mkdir(worktreeBase, { recursive: true });
  await git(repoRoot, ['worktree', 'add', '-b', `inline/${packetId}`, worktreePath]);
  return worktreePath;
}

async function exists(candidate: string) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

beforeAll(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'o8-maintenance-data-'));
  cleanupPaths.push(dataDir);
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
});

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  delete process.env.CORTEX_IDE_DATA_DIR;
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

describe('periodic worktree maintenance', () => {
  it('reclaims saved-repo orphans and transient-repo terminal worktrees', async () => {
    const savedRepo = await makeRepo('saved');
    const transientRepo = await makeRepo('transient');
    const savedOrphanPath = await makeWorktree(savedRepo, 'saved-orphan');
    const transientTerminalPath = await makeWorktree(transientRepo, 'transient-terminal');

    const stale = new Date(Date.now() - 2 * 60 * 60_000);
    await Promise.all([
      utimes(savedOrphanPath, stale, stale),
      utimes(path.join(savedOrphanPath, '.git'), stale, stale),
      utimes(path.join(savedOrphanPath, 'seed.txt'), stale, stale),
    ]);

    const now = new Date().toISOString();
    await writeFile(path.join(dataDir, 'repos.json'), `${JSON.stringify({
      version: 1,
      repos: [{
        id: 'saved-repo',
        name: 'saved',
        localPath: savedRepo,
        remoteUrl: null,
        defaultBranch: 'main',
        isGitRepo: true,
        setup: {},
        addedAt: now,
        lastOpenedAt: now,
      }],
    })}\n`, 'utf8');

    const [{ createLane }, { getSqlite }, { runWorktreeMaintenanceTick }] = await Promise.all([
      import('@/lib/lane/registry'),
      import('@/lib/db'),
      import('@/lib/lane/worktree-reaper'),
    ]);
    const lane = createLane({
      repoPath: transientRepo,
      branch: 'inline/transient-terminal',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'transient-terminal',
      worktreePath: transientTerminalPath,
    });
    getSqlite().prepare('UPDATE lanes SET status = ? WHERE id = ?').run('archived', lane.id);

    await runWorktreeMaintenanceTick();

    expect(await exists(savedOrphanPath), 'saved repo orphan is reclaimed').toBe(false);
    expect(await exists(transientTerminalPath), 'transient terminal lane is reclaimed').toBe(false);
  }, 60_000);
});
