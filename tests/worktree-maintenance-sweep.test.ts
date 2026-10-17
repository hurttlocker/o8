/**
 * Real maintenance-tick proof for fleet-wide terminal worktree cleanup.
 *
 * The app can run outside the repo it is operating on, so the periodic entry
 * point must cover both saved repos and transient repos known only by a lane.
 */
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  it('reclaims a managed terminal workspace and preserves an unmanaged terminal worktree', async () => {
    const savedRepo = await makeRepo('saved');
    const transientRepo = await makeRepo('transient');
    const { createManagedPacketWorktree } = await import('./helpers/managed-packet-worktree');
    const savedOrphan = await createManagedPacketWorktree(savedRepo, {
      packetId: 'saved-terminal', branch: 'inline/saved-terminal',
    });
    const savedOrphanPath = savedOrphan.path;
    const transientTerminalPath = await makeWorktree(transientRepo, 'transient-terminal');

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
    const savedLane = createLane({
      repoPath: savedRepo,
      branch: 'inline/saved-terminal',
      baseBranch: 'main', runtime: 'codex', packetId: 'saved-terminal',
      worktreePath: savedOrphanPath, sessionKey: savedOrphan.sessionKey,
    });
    getSqlite().prepare('UPDATE lanes SET status = ? WHERE id = ?').run('archived', lane.id);
    getSqlite().prepare('UPDATE lanes SET status = ? WHERE id = ?').run('archived', savedLane.id);

    // Maintenance advances bounded discovery phases over successive ticks.
    for (let tick = 0; tick < 20 && await exists(savedOrphanPath); tick += 1) {
      await runWorktreeMaintenanceTick();
    }

    expect(await exists(savedOrphanPath), 'saved terminal workspace is reclaimed').toBe(false);
    expect(await exists(transientTerminalPath), 'unmanaged terminal workspace is preserved').toBe(true);
  }, 60_000);
});
