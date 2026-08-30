/**
 * Pipeline root-fix contracts (2026-07-03) — the two predicates that buried
 * review-ready work. These sets ARE the policy; pin them so a future edit
 * that re-adds `reviewing` to the probe set or `silent_exit_work_present` to
 * the terminally-dead set fails loudly with this incident's context.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetPacketDiffBaseFetchMemoForTest } from '@/lib/diff/base-resolution';
import { resetCodexProcessCwdIndexForTesting, setCodexProcessReaderForTesting } from '@/lib/runtimes/shared/codex-process-cwd';
import { resetOwnedSessionIndex } from '@/lib/runtimes/shared/owned-session-index';
import { listInboxItems } from '@/lib/supervisor/inbox';
import {
  DEAD_LANE_EVENT_LABELS,
  INTERESTING_LANE_STATUSES,
  runSilentExitTickForTesting,
} from './silent-exit-detector';

const { createLane, deleteLane, getLane, getLaneEvents, listActiveLanes, updateLane } = await import('@/lib/lane/registry');
const { getMissionStatus } = await import('@/lib/orchestrator/operator-mission-service');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');

let ownedRoot: string | null = null;
let tempWorktree: string | null = null;
const testLaneIds: string[] = [];

function writeOwnedSession(surfaceId: string, activeRun: unknown): void {
  if (!ownedRoot) throw new Error('ownedRoot not initialized');
  const dir = join(ownedRoot, surfaceId.replace(/^codex-owned:/, ''));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ surfaceId, activeRun }));
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function commitAll(cwd: string, message: string): string {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

function makePacketClone(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');
  tempWorktree = root;

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, ['checkout', '-b', 'main']);
  writeFileSync(join(seed, 'base.txt'), 'base\n');
  commitAll(seed, 'base');
  git(seed, ['push', '-u', 'origin', 'main']);

  execFileSync('git', ['clone', origin, clone], { stdio: 'pipe' });
  git(clone, ['checkout', '-b', 'main', 'origin/main']);
  git(clone, ['checkout', '-b', 'packet']);
  writeFileSync(join(clone, 'packet.txt'), 'packet\n');
  const headSha = commitAll(clone, 'packet work');

  return { root, origin, seed, clone, headSha };
}

function createDeadOwnedLane(worktreePath: string, packetId: string) {
  ownedRoot = mkdtempSync(join(tmpdir(), 'o8-owned-codex-'));
  process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
  resetOwnedSessionIndex();
  setCodexProcessReaderForTesting(async () => []);

  const surfaceId = `codex-owned:${packetId}`;
  writeOwnedSession(surfaceId, {});
  const lane = createLane({
    repoPath: worktreePath,
    worktreePath,
    branch: 'packet',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: surfaceId,
    packetId,
  });
  testLaneIds.push(lane.id);
  updateLane(lane.id, {
    status: 'running',
    lastEventAt: new Date(Date.now() - 120_000).toISOString(),
    lastEventLabel: 'session_launched',
  });
  return lane;
}

beforeEach(() => {
  for (const lane of listActiveLanes()) {
    if (lane.packetId?.startsWith('pkt-silent-') || lane.packetId === 'pkt-live-cwd') {
      deleteLane(lane.id);
    }
  }
});

afterEach(() => {
  if (ownedRoot) rmSync(ownedRoot, { recursive: true, force: true });
  if (tempWorktree) rmSync(tempWorktree, { recursive: true, force: true });
  while (testLaneIds.length > 0) {
    deleteLane(testLaneIds.pop()!);
  }
  ownedRoot = null;
  tempWorktree = null;
  delete process.env.CORTEX_IDE_OWNED_CODEX_ROOT;
  resetOwnedSessionIndex();
  resetCodexProcessCwdIndexForTesting();
  resetPacketDiffBaseFetchMemoForTest();
});

describe('silent-exit detector policy (wave-1B burial incident)', () => {
  it('never probes reviewing lanes — a dead process after completion is normal, not a silent exit', () => {
    expect(INTERESTING_LANE_STATUSES.has('reviewing')).toBe(false);
    expect(INTERESTING_LANE_STATUSES.has('running')).toBe(true);
    expect(INTERESTING_LANE_STATUSES.has('awaiting_input')).toBe(true);
  });

  it('never auto-archives work-present lanes — committed work is review-ready, not terminally dead', () => {
    expect(DEAD_LANE_EVENT_LABELS.has('silent_exit_work_present')).toBe(false);
    expect(DEAD_LANE_EVENT_LABELS.has('silent_exit_no_work')).toBe(true);
    expect(DEAD_LANE_EVENT_LABELS.has('zombie_reap')).toBe(true);
  });

  it('does not salvage a quiet owned Codex lane when a live codex process is still in its worktree', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'o8-live-codex-wt-'));
    tempWorktree = worktreePath;
    ownedRoot = mkdtempSync(join(tmpdir(), 'o8-owned-codex-'));
    process.env.CORTEX_IDE_OWNED_CODEX_ROOT = ownedRoot;
    resetOwnedSessionIndex();

    const surfaceId = 'codex-owned:test-live-cwd';
    writeOwnedSession(surfaceId, { pid: 2_147_483_647 });
    setCodexProcessReaderForTesting(async () => [{
      pid: 12345,
      command: '/usr/local/bin/codex exec --resume abc',
      cwd: worktreePath,
    }]);

    const lane = createLane({
      repoPath: worktreePath,
      worktreePath,
      branch: 'pkt/live-cwd',
      runtime: 'codex',
      sessionKey: surfaceId,
      packetId: 'pkt-live-cwd',
    });
    updateLane(lane.id, {
      status: 'running',
      lastEventAt: new Date(Date.now() - 120_000).toISOString(),
      lastEventLabel: 'session_launched',
    });

    await runSilentExitTickForTesting();

    const after = getLane(lane.id);
    expect(after?.status).toBe('running');
    expect(after?.lastEventLabel).toBe('session_launched');
  });

  it('marks a dead silent-exit lane completed when the worktree HEAD is already merged into refreshed origin main', async () => {
    const { clone, seed, headSha } = makePacketClone('o8-silent-exit-merged');
    git(clone, ['push', 'origin', 'packet']);
    git(seed, ['fetch', 'origin', 'main', '--quiet']);
    git(seed, ['fetch', 'origin', 'packet', '--quiet']);
    git(seed, ['merge', '--ff-only', 'origin/packet']);
    git(seed, ['push', 'origin', 'main']);

    const packetId = `pkt-silent-merged-${Date.now()}`;
    const lane = createDeadOwnedLane(clone, packetId);

    await runSilentExitTickForTesting();

    const after = getLane(lane.id);
    expect(after?.status).toBe('completed');
    expect(after?.lastEventLabel).toBe('silent_exit_already_merged');
    expect(listInboxItems({ includeAllProjects: true }).some((item) => item.packetId === packetId)).toBe(false);
    expect(getLaneEvents(lane.id).some((event) => (
      event.verb === 'silent_exit_already_merged'
      && event.payload.headSha === headSha
      && event.payload.comparisonRef === 'origin/main'
    ))).toBe(true);
  }, 20_000);

  it('promotes a dead silent-exit lane to reviewing when committed work is not merged into refreshed origin main', async () => {
    const { clone } = makePacketClone('o8-silent-exit-unmerged');
    const packetId = `pkt-silent-unmerged-${Date.now()}`;
    const lane = createDeadOwnedLane(clone, packetId);
    const missionId = `mission-silent-unmerged-${Date.now()}`;
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId,
      prompt: 'Recover committed work after a silent worker exit.',
      summary: 'Silent-exit completion summary real path.',
      repoPath: clone,
      packets: [{
        id: packetId,
        referenceLabel: 'silent-1',
        title: 'Recover silent completion',
        summary: 'Promote committed work to review with a useful completion summary.',
        workspaceTargetPath: clone,
        branchTarget: 'packet',
        runtime: 'codex',
        dependencyLabels: [],
        dependencyPacketIds: [],
        queueState: 'queued',
        releaseState: 'pending',
        status: 'running',
        lane: null,
      }],
    });

    await runSilentExitTickForTesting();

    const after = getLane(lane.id);
    expect(after?.status).toBe('reviewing');
    expect(after?.lastEventLabel).toBe('silent_exit_work_present');
    expect(listInboxItems({ includeAllProjects: true }).some((item) => (
      item.packetId === packetId
      && item.kind === 'silent_exit_but_work_present'
    ))).toBe(true);

    const status = await getMissionStatus({ missionId, includeCost: false });
    expect(status.packets.find((packet) => packet.id === packetId)?.summary).toBe('packet work');
  }, 20_000);
});
