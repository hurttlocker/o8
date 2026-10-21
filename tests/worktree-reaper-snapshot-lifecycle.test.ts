import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, it, vi } from 'vitest';
import type { Lane } from '@/lib/lane/types';

const h = vi.hoisted(() => ({ beforeReconcile: null as null | (() => void) }));
vi.mock('@/lib/lane/bounded-worktree-maintenance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/bounded-worktree-maintenance')>();
  return {
    ...actual,
    runBoundedWorktreeMaintenance: (reconcile: (lane: Lane) => Promise<void>, options: { primaryRepoPath?: string }) => (
      actual.runBoundedWorktreeMaintenance(async (lane) => {
        const callback = h.beforeReconcile;
        h.beforeReconcile = null;
        callback?.();
        await reconcile(lane);
      }, options)
    ),
  };
});
process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-reaper-snapshot-data-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, deleteLane, getLane } = await import('@/lib/lane/registry');
const { runWorktreeMaintenanceTick } = await import('@/lib/lane/worktree-reaper');
const { createWorkspaceSnapshot, transitionWorkspaceSnapshot } = await import('@/lib/worktree/snapshot-state');
const fixtures: Array<{ repoPath: string; laneId: string }> = [];
afterAll(() => closeDb());
afterEach(() => {
  h.beforeReconcile = null;
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture.repoPath, { recursive: true, force: true });
    deleteLane(fixture.laneId);
  }
});

it.each(['parked', 'late-parked', 'materialized'] as const)(
  'respects missing %s workspace through the persisted maintenance tick', async (state) => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-reaper-snapshot-repo-'));
    const git = (args: string[]) => execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', '-q', '-b', 'main']);
    git(['config', 'user.email', 'test@example.test']);
    git(['config', 'user.name', 'test']);
    writeFileSync(join(repoPath, 'base.txt'), 'base\n');
    git(['add', 'base.txt']);
    git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'base']);
    const packetId = `pkt-reaper-${state}`;
    const worktreePath = join(repoPath, '.cortex-worktrees', packetId);
    const lane = createLane({ repoPath, worktreePath, branch: 'packet', baseBranch: 'main', runtime: 'codex', packetId });
    fixtures.push({ repoPath, laneId: lane.id });
    getSqlite().prepare("UPDATE lanes SET status = 'reviewing', updated_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 3 * 60 * 60_000).toISOString(), lane.id);
    const snapshotInput = {
      repositoryUuid: packetId, packetId, laneId: lane.id, originalPath: worktreePath,
      branch: 'packet', baseCommit: git(['rev-parse', 'HEAD']), headCommit: git(['rev-parse', 'HEAD']),
      treeSha: git(['rev-parse', 'HEAD^{tree}']), recoveryRef: `refs/o8/recovery/${packetId}`,
      diffFingerprint: 'test-diff', sessionIdentities: [], creationId: 'create',
    };
    const recordSnapshot = () => {
      let snapshot = createWorkspaceSnapshot(snapshotInput).record;
      if (state !== 'materialized') {
        for (const next of ['parkable', 'hibernating', 'parked'] as const) {
          snapshot = transitionWorkspaceSnapshot({
            repositoryUuid: packetId, packetId, transitionId: next,
            expectedState: snapshot.state, expectedVersion: snapshot.version, toState: next,
          }).record!;
        }
      }
    };
    if (state === 'late-parked') h.beforeReconcile = recordSnapshot;
    else recordSnapshot();
    await runWorktreeMaintenanceTick(repoPath);
    expect(getLane(lane.id)?.status).toBe(state === 'materialized' ? 'archived' : 'reviewing');
    expect(h.beforeReconcile).toBeNull();
  },
);
