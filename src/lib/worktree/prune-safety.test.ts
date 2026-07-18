/**
 * Real-path prune SAFETY guards (#1585).
 *
 * Drives the REAL `WorktreeManager.prune()` seam — the same entry point the
 * throttled auto-prune (`headless-loop.ts pruneWorktreesIfDue`) hits — against
 * REAL git worktrees on disk, and asserts the four invariants that stop the
 * pruner from `rm -rf`'ing live workers' cwds (the fleet-kill of 2026-07-18):
 *
 *   (a) a worktree bound to a NON-TERMINAL lane survives the age sweep;
 *   (b) an orphan dir whose mtime probe reads unknown/zero is KEPT (+ warn);
 *   (c) a lane-registry import failure ABORTS the pass — `[]`, no disk touched;
 *   (d) a worktree with a live process cwd'd inside survives (fail closed);
 *   (e) a genuinely stale, clean, process-free, no-lane worktree IS pruned
 *       (the disk-hygiene purpose the May-2026 disk-full incident bought).
 *
 * These go through the live lane registry + a persisted operator-defaults in a
 * sandboxed CORTEX_IDE_DATA_DIR, so a regression in the guard chain reddens here.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, mkdir, realpath, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);
const WORKTREE_DIR_NAME = '.cortex-worktrees';
// Well past STALE_THRESHOLD_MS (24h) so the age sweep considers the worktree.
const STALE_AGE_MS = 26 * 60 * 60_000;

let repoRoot: string;
let dataDir: string;
let base: string;
const bornProcs: ChildProcess[] = [];
const pathAliases: string[] = [];

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

/** Add a real git worktree under the repo's `.cortex-worktrees` and age its mtime. */
async function addWorktree(id: string, ageMs = STALE_AGE_MS): Promise<string> {
  const wtPath = path.join(base, id);
  await git(['worktree', 'add', wtPath, '-b', `worktree/codex/${id}`], repoRoot);
  const when = new Date(Date.now() - ageMs);
  await utimes(wtPath, when, when);
  return wtPath;
}

beforeEach(async () => {
  // realpath: macOS mkdtemp yields a /var symlink but git stores the resolved
  // /private/var path; the manager's #1404 realpath write-guard needs them equal.
  repoRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-prune-safety-')));
  dataDir = await realpath(await mkdtemp(path.join(tmpdir(), 'o8-prune-safety-data-')));
  process.env.CORTEX_IDE_DATA_DIR = dataDir;

  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(path.join(repoRoot, 'seed.txt'), 'seed\n', 'utf-8');
  await git(['add', 'seed.txt'], repoRoot);
  await git(['commit', '-m', 'seed'], repoRoot);

  base = path.join(repoRoot, WORKTREE_DIR_NAME);
  await mkdir(base, { recursive: true });
}, 60_000);

afterEach(async () => {
  for (const child of bornProcs.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  vi.restoreAllMocks();
  vi.doUnmock('@/lib/lane/registry');
  vi.resetModules();
  for (const aliasPath of pathAliases.splice(0)) {
    await unlink(aliasPath).catch(() => {});
  }
  if (repoRoot) await rm(repoRoot, { recursive: true, force: true }).catch(() => {});
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  delete process.env.CORTEX_IDE_DATA_DIR;
});

describe('WorktreeManager.prune() safety guards (#1585)', () => {
  it('(a)+(e) keeps a non-terminal-lane worktree but reaps a stale no-lane one', async () => {
    const { WorktreeManager } = await import('./manager');
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');

    const blockedPath = await addWorktree('packet-blocked');
    await addWorktree('packet-orphan-lane-free'); // no lane → genuine victim

    // A lane parked on an operator decision ("blocked — operator review
    // required" in the incident) is NON-TERMINAL and must protect its tree.
    const lane = createLane({
      repoPath: repoRoot,
      branch: 'worktree/codex/packet-blocked',
      baseBranch: 'main',
      runtime: 'codex',
      worktreePath: blockedPath,
    });
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'operator_review_required');

    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).not.toContain('packet-blocked');
    expect(pruned).toContain('packet-orphan-lane-free');
    expect(await exists(blockedPath), 'blocked-lane worktree survives').toBe(true);
    expect(await exists(path.join(base, 'packet-orphan-lane-free')), 'stale no-lane worktree reaped').toBe(false);
  }, 60_000);

  it('(b) keeps an orphan dir whose mtime probe reads unknown/zero, with a warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { WorktreeManager } = await import('./manager');

    // A raw (non-git, no-meta) packet dir → falls to the F39 orphan sweep.
    // mtime epoch-0 → probeMtimeMs() returns null (unknown age).
    const orphanPath = path.join(base, 'packet-mtime-unknown');
    await mkdir(orphanPath, { recursive: true });
    await writeFile(path.join(orphanPath, 'work.txt'), 'agent work\n', 'utf-8');
    await utimes(orphanPath, new Date(0), new Date(0));

    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).not.toContain('packet-mtime-unknown');
    expect(await exists(orphanPath), 'unknown-mtime orphan survives').toBe(true);
    expect(
      warnSpy.mock.calls.some(([msg]) =>
        typeof msg === 'string'
        && msg.includes('packet-mtime-unknown')
        && msg.includes('mtime probe failed/unknown'),
      ),
      'warned about the skipped unknown-mtime orphan',
    ).toBe(true);
  }, 60_000);

  it('(c) aborts with [] and touches no disk when the lane registry import fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.doMock('@/lib/lane/registry', () => ({
      listLanes: () => { throw new Error('registry boom (simulated import/read failure)'); },
    }));
    vi.resetModules();

    const staleA = await addWorktree('packet-registry-fail-a');
    const staleB = await addWorktree('packet-registry-fail-b');

    const { WorktreeManager } = await import('./manager');
    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).toEqual([]);
    expect(await exists(staleA), 'worktree untouched on registry failure').toBe(true);
    expect(await exists(staleB), 'worktree untouched on registry failure').toBe(true);
    expect(errorSpy.mock.calls.some(([message]) => (
      typeof message === 'string'
      && message.includes('PRUNE ABORTED — lane registry unavailable')
    ))).toBe(true);
  }, 60_000);

  it('(d) keeps a worktree with a live process cwd`d inside (fail closed)', async () => {
    const { WorktreeManager } = await import('./manager');

    const livePath = await addWorktree('packet-live-worker');

    // Spawn a real child whose cwd is inside the worktree — the live-worker
    // signature. `lsof +D` detects it by cwd even though the path is not argv.
    const child = spawn('sleep', ['60'], { cwd: livePath, stdio: 'ignore', detached: false });
    bornProcs.push(child);
    await new Promise((resolve) => setTimeout(resolve, 400)); // let it register

    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).not.toContain('packet-live-worker');
    expect(await exists(livePath), 'worktree with a live process survives').toBe(true);
  }, 60_000);

  it('manager cleanup refuses a live worktree at the deletion seam unless confirmed-kill override is explicit', async () => {
    const { WorktreeManager } = await import('./manager');
    const livePath = await addWorktree('packet-live-cleanup-seam');
    const child = spawn('sleep', ['60'], { cwd: livePath, stdio: 'ignore', detached: false });
    bornProcs.push(child);
    await new Promise((resolve) => setTimeout(resolve, 400));

    const mgr = new WorktreeManager(repoRoot);
    await expect(mgr.cleanup('packet-live-cleanup-seam', { force: true })).resolves.toBe(false);
    expect(await exists(livePath), 'live worktree survives ordinary cleanup').toBe(true);

    await expect(mgr.cleanup('packet-live-cleanup-seam', {
      force: true,
      overrideLiveGuard: true,
    })).resolves.toBe(true);
    expect(await exists(livePath), 'confirmed-kill override permits cleanup').toBe(false);
  }, 60_000);

  it('canonicalizes a symlinked lane worktree path before active-lane membership checks', async () => {
    const { WorktreeManager } = await import('./manager');
    const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
    const protectedPath = await addWorktree('packet-path-alias');
    const aliasRoot = repoRoot.startsWith('/private/var/')
      ? repoRoot.replace(/^\/private/, '')
      : `${repoRoot}-alias`;
    if (aliasRoot === `${repoRoot}-alias`) {
      await symlink(repoRoot, aliasRoot, 'dir');
      pathAliases.push(aliasRoot);
    }
    expect(await realpath(aliasRoot)).toBe(repoRoot);

    const lane = createLane({
      repoPath: aliasRoot,
      branch: 'worktree/codex/packet-path-alias',
      baseBranch: 'main',
      runtime: 'codex',
      worktreePath: path.join(aliasRoot, WORKTREE_DIR_NAME, 'packet-path-alias'),
    });
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'operator_review_required');

    const mgr = new WorktreeManager(repoRoot);
    const pruned = await mgr.prune();

    expect(pruned).not.toContain('packet-path-alias');
    expect(await exists(protectedPath), 'aliased non-terminal lane protects the real path').toBe(true);
  }, 60_000);
});
