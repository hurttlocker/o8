/**
 * #1522 — launching into an already-bound worktree must refresh it onto
 * current origin/base first.
 *
 * A queued (dispatch:false) mission's worktree was provisioned at CREATE
 * time; dispatching hours later launched straight into that clone
 * (isolate:false skips the create-time pre-launch rebase entirely), so the
 * worker built against the create-time base snapshot and its merge diff
 * showed everything merged in between as DELETIONS (~1,900 lines on the
 * pkt-30257397 incident).
 *
 * Real-path repro: a clone snapshotted at commit A, origin main advanced to
 * commit B, then the REAL `launch_session` lane command (runtime launch
 * mocked). The launch must land with the worktree branch fast-forwarded to
 * contain B, and a worktree_refreshed lane event recorded.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-stale-base-'));
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const launchRuntimeSurfaceMock = vi.fn(async () => ({
  ok: true as const,
  surfaceId: 'codex-owned:stale-base-test',
  note: 'launched',
}));
vi.mock('@/lib/runtime/actions', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/runtime/actions')>();
  return { ...original, launchRuntimeSurface: launchRuntimeSurfaceMock };
});

const { dispatch } = await import('@/lib/lane/commands');
const { createLane, updateLane, getLaneEvents } = await import('@/lib/lane/registry');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

describe('#1522 — stale-base worktree refreshes at dispatch time', () => {
  it('fast-forwards a create-time clone onto current origin/main before launch', async () => {
    // Origin repo at commit A.
    const originPath = join(dataDir, 'origin-repo');
    execFileSync('git', ['init', '-q', '-b', 'main', originPath]);
    git(originPath, 'config', 'user.email', 'test@o8.test');
    git(originPath, 'config', 'user.name', 'o8 test');
    writeFileSync(join(originPath, 'base.txt'), 'base\n');
    git(originPath, 'add', 'base.txt');
    git(originPath, 'commit', '-q', '-m', 'commit A: base');

    // The create-time snapshot: clone + branch cut from then-main.
    const clonePath = join(dataDir, 'stale-clone');
    execFileSync('git', ['clone', '-q', '--local', originPath, clonePath]);
    git(clonePath, 'config', 'user.email', 'test@o8.test');
    git(clonePath, 'config', 'user.name', 'o8 test');
    git(clonePath, 'checkout', '-q', '-B', 'issue/stale-base', 'main');

    // Waves land on origin main AFTER the snapshot.
    writeFileSync(join(originPath, 'wave.txt'), 'merged wave work\n');
    git(originPath, 'add', 'wave.txt');
    git(originPath, 'commit', '-q', '-m', 'commit B: wave merged after snapshot');
    const waveSha = git(originPath, 'rev-parse', 'HEAD');

    // The persisted lane state a queued packet dispatches from.
    const lane = createLane({
      label: 'stale base lane',
      repoPath: originPath,
      branch: 'issue/stale-base',
      baseBranch: 'main',
      runtime: 'codex',
      packetId: 'pkt-stale-base',
    });
    updateLane(lane.id, { worktreePath: clonePath });

    const result = await dispatch({
      verb: 'launch_session',
      laneId: lane.id,
      prompt: 'build against a fresh base',
      actor: 'orchestrator',
    });

    expect(result.ok).toBe(true);
    expect(launchRuntimeSurfaceMock).toHaveBeenCalledOnce();

    // The branch the worker landed on now CONTAINS the post-snapshot wave —
    // the old code launched at commit A and the merge diff deleted wave.txt.
    const branchTip = git(clonePath, 'rev-parse', 'issue/stale-base');
    const containsWave = execFileSync(
      'git', ['merge-base', '--is-ancestor', waveSha, branchTip],
      { cwd: clonePath },
    );
    expect(containsWave.toString()).toBe('');

    const refreshed = getLaneEvents(lane.id, 50).find((event) => event.verb === 'worktree_refreshed');
    expect(refreshed).toBeTruthy();
  }, 30_000);
});
