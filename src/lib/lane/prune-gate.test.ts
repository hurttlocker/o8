import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PRUNE_RECENT_MTIME_MS, checkPruneGate } from './prune-gate';
import { createLane, setLaneStatus } from './registry';
import { removeCortexWorktreePath } from './worktree-clone-removal';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('prune gate — real temp git repo (mktemp, no mocks)', () => {
  let root: string;
  let repoRoot: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'o8-prune-gate-'));
    repoRoot = join(root, 'repo');
    mkdirSync(repoRoot);
    git(repoRoot, ['init', '-q']);
    git(repoRoot, ['config', 'user.email', 'gate@test']);
    git(repoRoot, ['config', 'user.name', 'gate']);
    git(repoRoot, ['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repoRoot, 'README.md'), '# base\n');
    git(repoRoot, ['add', '-A']);
    git(repoRoot, ['commit', '-qm', 'base']);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function addWorktree(name: string, branch: string): string {
    const wt = join(repoRoot, '.cortex-worktrees', name);
    git(repoRoot, ['worktree', 'add', '-q', '-b', branch, wt]);
    return wt;
  }

  it('refuses a worktree with uncommitted work (no lane); operatorForce deletes it', async () => {
    const wt = addWorktree('packet-dirty', 'inline/gate-dirty');
    writeFileSync(join(wt, 'scratch.txt'), 'agent mid-edit\n'); // uncommitted

    const refused = await checkPruneGate({ repoRoot, worktreePath: wt });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain('uncommitted_work');

    // The REAL low-level removal entry point refuses too — this is exactly the
    // dirty check the force path lacked when it ate worktrees mid-surgery (#1498).
    expect(await removeCortexWorktreePath({ repoRoot, worktreePath: wt, logPrefix: 'prune-gate-test' })).toBe(false);
    expect(existsSync(wt)).toBe(true);

    // operatorForce overrides — decision reports forced, and the real path deletes.
    const forced = await checkPruneGate({ repoRoot, worktreePath: wt, operatorForce: true });
    expect(forced).toMatchObject({ ok: true, forced: true });
    expect(forced.reason).toContain('uncommitted_work');

    expect(
      await removeCortexWorktreePath({ repoRoot, worktreePath: wt, logPrefix: 'prune-gate-test', operatorForce: true }),
    ).toBe(true);
    expect(existsSync(wt)).toBe(false);
  });

  it('refuses while the owning lane is non-terminal, allows once terminal', async () => {
    const wt = addWorktree('packet-lane', 'inline/gate-lane');
    // Commit so there is no uncommitted-work signal. mtime stays recent — a
    // CONFIRMED terminal lane must waive the recent-activity check, a
    // non-terminal one must not.
    writeFileSync(join(wt, 'work.txt'), 'done\n');
    git(wt, ['add', '-A']);
    git(wt, ['commit', '-qm', 'work']);

    const lane = createLane({
      repoPath: repoRoot,
      branch: 'inline/gate-lane',
      baseBranch: 'main',
      runtime: 'codex',
      worktreePath: wt,
    });

    // idle (non-terminal) → refuse on lane_non_terminal.
    const nonTerminal = await checkPruneGate({ repoRoot, worktreePath: wt, laneId: lane.id });
    expect(nonTerminal.ok).toBe(false);
    expect(nonTerminal.reason).toContain('lane_non_terminal');

    // completed (lane-terminal) → allow: lifecycle-over waives dirty/recent.
    setLaneStatus(lane.id, 'completed', 'system', 'merged');
    const terminal = await checkPruneGate({ repoRoot, worktreePath: wt, laneId: lane.id });
    expect(terminal.ok).toBe(true);
    expect(terminal.forced).toBeFalsy();
  });

  it('fails closed on an empty worktree path', async () => {
    expect(await checkPruneGate({ repoRoot, worktreePath: '   ' })).toMatchObject({
      ok: false,
      reason: 'empty_path',
    });
  });

  it('uses a conservative 30-minute recent-mtime default', () => {
    expect(PRUNE_RECENT_MTIME_MS).toBe(30 * 60_000);
  });
});
