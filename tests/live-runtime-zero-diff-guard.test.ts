import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-live-zero-diff-data-'));
const ownedOpenCodeRoot = join(dataDir, 'owned-opencode');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_OWNED_OPENCODE_ROOT = ownedOpenCodeRoot;

const { dispatch } = await import('@/lib/lane/commands');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
const { shouldDeferCompletionForLiveRuntime } = await import('@/lib/supervisor/completion-liveness');

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.O8_OWNED_OPENCODE_ROOT;
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeCleanWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'o8-live-zero-diff-wt-'));
  tempDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@o8.dev']);
  git(dir, ['config', 'user.name', 'o8 test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', 'base.txt']);
  git(dir, ['commit', '-q', '--no-verify', '-m', 'base']);
  return dir;
}

describe('live runtime zero-diff guard', () => {
  it('keeps a zero-diff lane running while its owned worker process is alive', async () => {
    const worktreePath = makeCleanWorktree();
    const surfaceId = 'opencode-owned:live-zero-diff';
    const sessionDir = join(ownedOpenCodeRoot, 'live-zero-diff');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
      surfaceId,
      activeRun: { pid: process.pid },
    }));
    resetOwnedSessionIndex();

    const lane = createLane({
      repoPath: worktreePath,
      worktreePath,
      branch: 'pkt/live-zero-diff',
      baseBranch: 'main',
      runtime: 'opencode',
      sessionKey: surfaceId,
      packetId: 'pkt-live-zero-diff',
    });
    setLaneStatus(lane.id, 'running', 'system', 'session_launched');

    const result = await dispatch({
      verb: 'request_review',
      laneId: lane.id,
      actor: 'system',
    });

    expect(result).toMatchObject({
      ok: false,
      note: 'runtime_still_running',
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'running',
      lastEventLabel: 'session_launched',
    });

    writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({ surfaceId }));
    resetOwnedSessionIndex();
    await expect(shouldDeferCompletionForLiveRuntime(lane)).resolves.toBe(false);
  });
});
