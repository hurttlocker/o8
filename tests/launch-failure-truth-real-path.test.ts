import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-launch-failure-truth-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const launchRuntimeSurface = vi.fn(async () => ({
  ok: false,
  runtime: 'codex' as const,
  surfaceId: '',
  note: 'spawn failed: executable unavailable',
  cwd: '',
  repoPath: '',
  worktree: null,
  laneId: null,
}));

vi.mock('@/lib/runtime/actions', () => ({ launchRuntimeSurface }));

const { dispatch } = await import('@/lib/lane/commands');
const { createLane, getLane, getLaneEvents } = await import('@/lib/lane/registry');
const { getSqlite } = await import('@/lib/db');

const repos: string[] = [];

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'o8-launch-failure-truth-repo-'));
  repos.push(repo);
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@o8.dev']);
  git(repo, ['config', 'user.name', 'o8 test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-q', '--no-verify', '-m', 'base']);
  return repo;
}

beforeEach(() => {
  launchRuntimeSurface.mockClear();
  getSqlite().prepare('DELETE FROM lane_events').run();
  getSqlite().prepare('DELETE FROM lanes').run();
});

afterAll(() => {
  for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('launch failure truth through the lane command path', () => {
  it('persists the cause and refuses an empty review transition', async () => {
    const repo = makeRepo();
    const lane = createLane({
      repoPath: repo,
      worktreePath: repo,
      branch: 'packet/launch-failure-truth',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-launch-failure-truth',
    });

    const launch = await dispatch({
      verb: 'launch_session',
      laneId: lane.id,
      prompt: 'Run the task.',
      actor: 'orchestrator',
    });

    expect(launch).toMatchObject({
      ok: false,
      note: 'spawn failed: executable unavailable',
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'idle',
      lastEventLabel: 'launch_failed',
      outcomeNote: 'spawn failed: executable unavailable',
    });

    const failureEvent = getLaneEvents(lane.id, 20).find((event) => (
      event.verb === 'status_change' && event.payload.eventLabel === 'launch_failed'
    ));
    expect(failureEvent?.payload).toMatchObject({
      reason: 'spawn failed: executable unavailable',
      error: 'spawn failed: executable unavailable',
      runtime: 'codex',
      binaryName: 'codex',
    });
    expect(failureEvent?.payload).toHaveProperty('resolvedBinaryPath');

    const review = await dispatch({
      verb: 'request_review',
      laneId: lane.id,
      actor: 'orchestrator',
    });

    expect(review).toMatchObject({
      ok: false,
      note: 'spawn failed: executable unavailable',
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'idle',
      lastEventLabel: 'launch_failed',
    });
    expect(getLaneEvents(lane.id, 20).some((event) => (
      event.verb === 'status_change' && event.payload.eventLabel === 'review_requested'
    ))).toBe(false);
  });
});
