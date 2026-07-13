/**
 * Real-path retention-enforcement guard.
 *
 * Drives the REAL `WorktreeManager.prune()` seam against a REAL git repo with
 * REAL git worktrees — the same entry point the throttled auto-prune hits — and
 * asserts the three retention guarantees the feature promises:
 *   1. the persisted `worktreeMaxCount` ceiling is respected (excess reclaimed),
 *   2. removal is OLDEST-FIRST (older clean worktrees go before newer ones),
 *   3. a worktree with uncommitted changes is NEVER deleted (skipped + kept),
 *      even when it is the oldest and thus first in the victim order.
 *
 * The limit is read through the real operator-defaults resolver from a persisted
 * `operator-defaults.json` in a sandboxed data dir (not injected), so a
 * regression in the resolve/persist chain reddens here too.
 */
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const WORKTREE_DIR_NAME = '.cortex-worktrees';

let repoRoot: string;
let dataDir: string;
let base: string;

async function git(args: string[], cwd: string) {
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

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// Worktrees oldest → newest. `dirty` gets an untracked file so `git status
// --porcelain` is non-empty at prune time.
const WORKTREES: Array<{ id: string; ageMinutes: number; dirty: boolean }> = [
  { id: 'packet-a', ageMinutes: 40, dirty: false }, // oldest, clean → first victim
  { id: 'packet-b', ageMinutes: 30, dirty: true },  // dirty → must survive
  { id: 'packet-c', ageMinutes: 20, dirty: false }, // clean → second victim
  { id: 'packet-d', ageMinutes: 10, dirty: false }, // newest, clean → kept (under limit)
];

beforeAll(async () => {
  // realpath: on macOS mkdtemp yields a /var symlink, but `git worktree` stores
  // the resolved /private/var path — the manager's #1404 realpath write-guard
  // aborts cleanup when the two disagree. Production repo roots aren't symlinks.
  repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-wt-retention-')));
  dataDir = await mkdtemp(path.join(tmpdir(), 'o8-wt-retention-data-'));
  // The real resolver reads operator-defaults.json from CORTEX_IDE_DATA_DIR; the
  // lane registry it consults for the active-lane guard uses the same (empty →
  // zero active lanes → every worktree is a safe candidate).
  process.env.CORTEX_IDE_DATA_DIR = dataDir;

  // Persist the ceiling through the real file path: keep 2, count-axis only.
  await writeFile(
    path.join(dataDir, 'operator-defaults.json'),
    `${JSON.stringify({ worktreeMaxCount: 2, worktreeMaxTotalGb: 0 }, null, 2)}\n`,
    'utf-8',
  );

  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(path.join(repoRoot, 'seed.txt'), 'seed\n', 'utf-8');
  await git(['add', 'seed.txt'], repoRoot);
  await git(['commit', '-m', 'seed'], repoRoot);

  base = path.join(repoRoot, WORKTREE_DIR_NAME);
  await mkdir(base, { recursive: true });

  for (const wt of WORKTREES) {
    const wtPath = path.join(base, wt.id);
    await git(['worktree', 'add', wtPath, '-b', `worktree/codex/${wt.id}`], repoRoot);
    if (wt.dirty) {
      // Untracked file → dirty working tree, but nothing committed.
      await writeFile(path.join(wtPath, 'scratch.txt'), 'unsaved work\n', 'utf-8');
    }
  }

  // Stamp deterministic mtimes LAST (writing the dirty file touched a dir mtime),
  // so getLastModified() yields the oldest-first order we assert on.
  const now = Date.now();
  for (const wt of WORKTREES) {
    const when = new Date(now - wt.ageMinutes * 60_000);
    await utimes(path.join(base, wt.id), when, when);
  }
}, 60_000);

afterAll(async () => {
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true });
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  delete process.env.CORTEX_IDE_DATA_DIR;
});

describe('WorktreeManager.prune() retention enforcement', () => {
  it('reclaims oldest-first down to the persisted limit but refuses to delete a dirty worktree', async () => {
    // Import after CORTEX_IDE_DATA_DIR is set so the resolver reads the sandbox.
    const { WorktreeManager } = await import('./manager');
    const mgr = new WorktreeManager(repoRoot);

    const pruned = await mgr.prune();

    // Oldest clean (a) and next clean (c) are removed; the dirty one (b) is
    // skipped even though it is older than c, and the newest (d) is under limit.
    expect(pruned).toContain('packet-a');
    expect(pruned).toContain('packet-c');
    expect(pruned).not.toContain('packet-b');
    expect(pruned).not.toContain('packet-d');

    // Observable disk state matches: exactly the survivors remain.
    expect(await exists(path.join(base, 'packet-a')), 'oldest clean pruned').toBe(false);
    expect(await exists(path.join(base, 'packet-c')), 'second clean pruned').toBe(false);
    expect(await exists(path.join(base, 'packet-b')), 'dirty worktree kept').toBe(true);
    expect(await exists(path.join(base, 'packet-d')), 'newest under-limit worktree kept').toBe(true);

    // The dirty tree still holds its unsaved file — we never touched it.
    expect(await exists(path.join(base, 'packet-b', 'scratch.txt'))).toBe(true);
  }, 60_000);
});
