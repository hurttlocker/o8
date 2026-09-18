import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/worktree/live-process-guard', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/worktree/live-process-guard')>(),
  allowWorktreeRemoval: vi.fn(async () => false),
}));

const { getSqlite } = await import('@/lib/db');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { sweepTerminalCortexWorktrees } = await import('@/lib/lane/terminal-worktree-sweep');

const roots: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, [
    '-c', 'user.name=o8-test',
    '-c', 'user.email=o8@example.test',
    'commit', '-m', message,
  ]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function createCloneFixture(status: 'completed' | 'archived' = 'archived') {
  const root = mkdtempSync(join(tmpdir(), 'o8-terminal-preserve-loop-'));
  roots.push(root);
  const origin = join(root, 'origin.git');
  const repoPath = join(root, 'canonical');
  const packetId = 'pkt-cleanup-preserve-loop';
  const branch = 'inline/cleanup-preserve-loop';
  const worktreeRoot = join(repoPath, '.cortex-worktrees');
  const worktreePath = join(worktreeRoot, `packet-${packetId}`);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, repoPath], { stdio: 'pipe' });
  git(repoPath, ['checkout', '-b', 'main']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  commitAll(repoPath, 'base');
  git(repoPath, ['push', '-u', 'origin', 'main']);

  mkdirSync(worktreeRoot, { recursive: true });
  execFileSync('git', ['clone', origin, worktreePath], { stdio: 'pipe' });
  git(worktreePath, ['checkout', '-b', branch, 'origin/main']);
  writeFileSync(join(worktreePath, 'packet.txt'), 'recoverable packet work\n');
  const headSha = commitAll(worktreePath, 'packet work');

  const lane = createLane({
    repoPath,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
  });
  getSqlite().prepare(`
    UPDATE lanes
    SET status = ?, worktree_path = NULL
    WHERE id = ?
  `).run(status, lane.id);

  return { headSha, laneId: lane.id, packetId, repoPath, worktreePath };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('terminal worktree sweep preservation', () => {
  it('records one preservation across repeated failed sweeps of an archived lane', async () => {
    const fixture = createCloneFixture();

    const first = await sweepTerminalCortexWorktrees(fixture.repoPath);
    const second = await sweepTerminalCortexWorktrees(fixture.repoPath);

    expect(first).toMatchObject({ scanned: 1, removed: 0, failed: 1 });
    expect(second).toMatchObject({ scanned: 1, removed: 0, failed: 1 });
    const preservedEvents = getLaneEvents(fixture.laneId, 100).filter((event) => (
      event.payload.event === 'recoverable_work_preserved'
      && event.payload.reason === 'terminal_worktree_cleanup'
    ));
    expect(preservedEvents).toHaveLength(1);

    const preservedRef = `refs/heads/preserved/packet-${fixture.packetId}`;
    expect(git(fixture.repoPath, ['rev-parse', preservedRef])).toBe(fixture.headSha);
    expect(git(fixture.worktreePath, ['rev-parse', 'HEAD'])).toBe(fixture.headSha);
  }, 30_000);

  it('reconciles an outcome when archival follows the first preservation pass', async () => {
    const fixture = createCloneFixture('completed');

    const first = await sweepTerminalCortexWorktrees(fixture.repoPath);
    expect(first).toMatchObject({ scanned: 1, removed: 0, failed: 1 });
    expect(getLane(fixture.laneId)?.outcome).toBeNull();

    getSqlite().prepare(`
      UPDATE lanes
      SET status = 'archived', outcome = 'no_changes', outcome_note = NULL
      WHERE id = ?
    `).run(fixture.laneId);

    const second = await sweepTerminalCortexWorktrees(fixture.repoPath);
    expect(second).toMatchObject({ scanned: 1, removed: 0, failed: 1 });

    const preservedEvents = getLaneEvents(fixture.laneId, 100).filter((event) => (
      event.payload.event === 'recoverable_work_preserved'
      && event.payload.reason === 'terminal_worktree_cleanup'
    ));
    expect(preservedEvents).toHaveLength(1);
    expect(getLane(fixture.laneId)).toMatchObject({
      status: 'archived',
      outcome: 'archived_recoverable',
    });

    const preservedRef = `refs/heads/preserved/packet-${fixture.packetId}`;
    expect(git(fixture.repoPath, ['rev-parse', preservedRef])).toBe(fixture.headSha);
  }, 30_000);
});
