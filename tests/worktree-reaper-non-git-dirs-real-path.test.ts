import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

// The live-process probe shells out to lsof for the whole machine; the fixture
// decides whether removal is allowed.
let allowRemoval = true;
vi.mock('@/lib/worktree/live-process-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/live-process-guard')>(),
  allowWorktreeRemoval: vi.fn(async () => allowRemoval),
}));

const { getSqlite } = await import('@/lib/db');
const { createLane } = await import('@/lib/lane/registry');
const { runWorktreeMaintenanceTick } = await import('@/lib/lane/worktree-reaper');
// Loaded before process.cwd() is pinned so the tick's dynamic imports resolve from cache.
await import('@/lib/lane/terminal-worktree-sweep');
await import('@/lib/repos/registry');

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string) {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
}

type FixtureKind = 'no-git-entry' | 'dangling-gitfile' | 'clone';

function createRepoFixture(packetId: string, kind: FixtureKind) {
  const root = mkdtempSync(join(tmpdir(), 'o8-reaper-non-git-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const repoPath = join(root, 'canonical');
  const worktreeRoot = join(repoPath, '.cortex-worktrees');
  const worktreePath = join(worktreeRoot, `packet-${packetId}`);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repoPath], { stdio: 'pipe' });
  git(repoPath, ['checkout', '-b', 'main']);
  writeFileSync(join(repoPath, '.gitignore'), '.cortex-worktrees/\n');
  commitAll(repoPath, 'base');
  git(repoPath, ['push', '-u', 'origin', 'main']);

  mkdirSync(worktreeRoot, { recursive: true });
  if (kind === 'clone') {
    execFileSync('git', ['clone', origin, worktreePath], { stdio: 'pipe' });
    git(worktreePath, ['checkout', '-b', `inline/${packetId}`, 'origin/main']);
    writeFileSync(join(worktreePath, 'packet.txt'), 'packet work\n');
    commitAll(worktreePath, 'packet work');
  } else {
    // The packet's git metadata is gone; only agent scratch files remain.
    mkdirSync(join(worktreePath, 'scratch'), { recursive: true });
    writeFileSync(join(worktreePath, 'scratch', 'notes.md'), 'agent scratch\n');
    if (kind === 'dangling-gitfile') {
      // git answers `fatal: not a git repository: (null)` for this shape.
      writeFileSync(join(worktreePath, '.git'), `gitdir: ${join(root, 'gone', 'worktrees', packetId)}\n`);
    }
  }

  const lane = createLane({
    repoPath,
    branch: `inline/${packetId}`,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
  });
  getSqlite().prepare(`UPDATE lanes SET status = 'archived', worktree_path = NULL WHERE id = ?`).run(lane.id);

  return { repoPath, worktreePath };
}

function captureLogs() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  vi.spyOn(console, 'log').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);
  return lines;
}

async function tick(repoPath: string, lines: string[]) {
  const start = lines.length;
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(repoPath);
  try {
    await runWorktreeMaintenanceTick();
  } finally {
    cwd.mockRestore();
  }
  return lines.slice(start);
}

afterEach(() => {
  vi.restoreAllMocks();
  allowRemoval = true;
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('worktree reaper terminal sweep — non-git packet directories (#2474)', () => {
  it.each<FixtureKind>(['dangling-gitfile', 'no-git-entry'])(
    'removes a %s directory of an archived lane once and logs one line for it',
    async (kind) => {
      const packetId = `pkt-non-git-${kind}`;
      const fixture = createRepoFixture(packetId, kind);
      const lines = captureLogs();

      const first = await tick(fixture.repoPath, lines);
      expect(existsSync(fixture.worktreePath)).toBe(false);
      expect(first.filter((line) => line.includes(fixture.worktreePath))).toHaveLength(1);
      expect(first.some((line) => /terminal sweep .*removed=1 .*failed=0/.test(line))).toBe(true);
      // Nothing was banked: the parent checkout's HEAD is not the packet's head.
      expect(git(fixture.repoPath, ['branch', '--list', `preserved/packet-${packetId}`])).toBe('');

      const second = await tick(fixture.repoPath, lines);
      expect(second).toEqual([]);
    },
    30_000,
  );

  it('skips a non-git directory whose removal failed on the next tick without new warnings', async () => {
    const fixture = createRepoFixture('pkt-non-git-refused', 'dangling-gitfile');
    allowRemoval = false;
    const lines = captureLogs();

    const first = await tick(fixture.repoPath, lines);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(first.some((line) => /terminal sweep .*removed=0 .*failed=1/.test(line))).toBe(true);

    const second = await tick(fixture.repoPath, lines);
    expect(second).toEqual([]);
    expect(existsSync(fixture.worktreePath)).toBe(true);
  }, 30_000);

  it('keeps retrying a valid clone refused by the live-process guard until the worker exits', async () => {
    const fixture = createRepoFixture('pkt-live-guard-refused', 'clone');
    allowRemoval = false;
    const lines = captureLogs();

    const first = await tick(fixture.repoPath, lines);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(first.some((line) => /terminal sweep .*removed=0 .*failed=1 skippedUnrecoverable=0/.test(line))).toBe(true);

    const second = await tick(fixture.repoPath, lines);
    expect(existsSync(fixture.worktreePath)).toBe(true);
    expect(second.some((line) => /terminal sweep .*removed=0 .*failed=1 skippedUnrecoverable=0/.test(line))).toBe(true);

    allowRemoval = true;
    const third = await tick(fixture.repoPath, lines);
    expect(existsSync(fixture.worktreePath)).toBe(false);
    expect(third.some((line) => /terminal sweep .*removed=1 .*failed=0/.test(line))).toBe(true);
  }, 30_000);
});
