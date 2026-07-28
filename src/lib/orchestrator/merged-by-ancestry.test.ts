import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { OrchestratorLaneBinding, OrchestratorPacket } from '@/lib/orchestrator/types';

process.env.CORTEX_IDE_DATA_DIR = mkdtempSync(join(tmpdir(), 'o8-merged-by-ancestry-data-'));
process.env.O8_DATA_DIR = process.env.CORTEX_IDE_DATA_DIR;
process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT = mkdtempSync(
  join(tmpdir(), 'o8-merged-by-ancestry-owned-claude-'),
);

const { createLane, deleteLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { readOrchestratorControlPlaneState, writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { sweepPacketsMergedByAncestry } = await import('@/lib/orchestrator/merged-by-ancestry');
const { resetOwnedSessionIndex } = await import('@/lib/runtimes/shared/owned-session-index');
const { prepareMissionBranches } = await import('@/lib/orchestrator/operator-mission-service/branch-cleanup');

const tempDirs: string[] = [];
const laneIds: string[] = [];

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

function makeRepo(name: string) {
  const root = mkdtempSync(join(tmpdir(), `${name}-`));
  const origin = join(root, 'origin.git');
  const seed = join(root, 'seed');
  const clone = join(root, 'clone');
  tempDirs.push(root);

  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, seed], { stdio: 'pipe' });
  git(seed, ['checkout', '-b', 'main']);
  writeFileSync(join(seed, 'README.md'), 'base\n');
  commitAll(seed, 'base');
  git(seed, ['push', '-u', 'origin', 'main']);

  execFileSync('git', ['clone', origin, clone], { stdio: 'pipe' });
  git(clone, ['checkout', '-b', 'main', 'origin/main']);
  git(clone, ['checkout', '-b', 'packet']);

  return { root, origin, seed, clone };
}

function packetFixture(
  repoPath: string,
  packetId: string,
  laneId: string,
  options: { branch?: string; runtime?: 'codex' | 'claude-code'; sessionKey?: string } = {},
): OrchestratorPacket {
  const branch = options.branch ?? 'packet';
  const runtime = options.runtime ?? 'codex';
  return {
    id: packetId,
    referenceLabel: packetId,
    title: packetId,
    summary: packetId,
    workspaceTargetPath: repoPath,
    branchTarget: branch,
    runtime,
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'held',
    releaseState: 'pending',
    status: 'awaiting_review',
    blockedReason: null,
    lastEventAt: null,
    lastEventLabel: null,
    archivedAt: null,
    review: null,
    lane: {
      tileId: laneId,
      tabId: laneId,
      repoPath,
      worktreePath: repoPath,
      runtime,
      laneId,
      sessionKey: options.sessionKey ?? `codex-owned:${laneId}`,
    } satisfies OrchestratorLaneBinding,
  };
}

function writeFreshClaudeTranscript(sessionKey: string): void {
  const sessionDir = join(
    process.env.CORTEX_IDE_OWNED_CLAUDE_CODE_ROOT!,
    sessionKey.replace(/^claude-code-owned:/, ''),
  );
  const runsDir = join(sessionDir, 'runs');
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(sessionDir, 'session.json'), JSON.stringify({
    surfaceId: sessionKey,
    activeRun: {},
  }));
  const runPath = join(runsDir, 'run-1.jsonl');
  writeFileSync(runPath, '{"type":"assistant","message":"still working"}\n');
  const now = new Date();
  utimesSync(runPath, now, now);
  resetOwnedSessionIndex();
}

function seedPacket(repoPath: string, packetId: string) {
  const lane = createLane({
    repoPath,
    worktreePath: repoPath,
    branch: 'packet',
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
  });
  laneIds.push(lane.id);
  setLaneStatus(lane.id, 'reviewing', 'system', 'ready_for_review');
  writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${packetId}`,
    repoPath,
    packets: [packetFixture(repoPath, packetId, lane.id)],
  });
  return lane;
}

function persistedPacket(packetId: string) {
  return readOrchestratorControlPlaneState().packets.find((packet) => packet.id === packetId);
}

afterEach(() => {
  while (laneIds.length > 0) {
    deleteLane(laneIds.pop()!);
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('merged-by-ancestry reconciliation', () => {
  it('releases packet and archives lane when branch head is ancestor of origin/main', async () => {
    const { clone, seed } = makeRepo('o8-merged-ancestor');
    writeFileSync(join(clone, 'packet.txt'), 'packet\n');
    commitAll(clone, 'packet work');
    git(clone, ['push', 'origin', 'packet']);
    git(seed, ['fetch', 'origin', 'packet', '--quiet']);
    git(seed, ['merge', '--ff-only', 'origin/packet']);
    git(seed, ['push', 'origin', 'main']);

    const lane = seedPacket(clone, 'pkt-ancestor');

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 1 });

    const packet = persistedPacket('pkt-ancestor');
    expect(packet?.status).toBe('released');
    expect(packet?.releaseState).toBe('released');
    expect(packet?.releaseStatePayload?.source).toBe('merged_by_ancestry_reconcile');
    expect(getLane(lane.id)?.status).toBe('archived');
  }, 20_000);

  it('releases packet and archives lane when squash-equivalent content is on origin/main', async () => {
    const { clone, seed } = makeRepo('o8-merged-squash');
    writeFileSync(join(clone, 'a.txt'), 'a\n');
    commitAll(clone, 'packet work a');
    writeFileSync(join(clone, 'b.txt'), 'b\n');
    commitAll(clone, 'packet work b');
    git(clone, ['push', 'origin', 'packet']);
    git(seed, ['fetch', 'origin', 'packet', '--quiet']);
    git(seed, ['merge', '--squash', 'origin/packet']);
    commitAll(seed, 'squash packet work');
    git(seed, ['push', 'origin', 'main']);

    const lane = seedPacket(clone, 'pkt-squash');

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 1 });

    const packet = persistedPacket('pkt-squash');
    expect(packet?.status).toBe('released');
    expect(packet?.lastEventLabel).toBe('merged_by_patch_id');
    expect(getLane(lane.id)?.status).toBe('archived');
  }, 20_000);

  it('leaves unmerged branch content untouched', async () => {
    const { clone } = makeRepo('o8-merged-unmerged');
    writeFileSync(join(clone, 'packet.txt'), 'packet\n');
    commitAll(clone, 'packet work');
    const lane = seedPacket(clone, 'pkt-unmerged');

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 0 });

    const packet = persistedPacket('pkt-unmerged');
    expect(packet?.status).toBe('awaiting_review');
    expect(packet?.releaseState).toBe('pending');
    expect(getLane(lane.id)?.status).toBe('reviewing');
  }, 20_000);

  it('leaves partial squash content untouched', async () => {
    const { clone, seed } = makeRepo('o8-merged-partial');
    writeFileSync(join(clone, 'a.txt'), 'a\n');
    const firstCommit = commitAll(clone, 'packet work a');
    writeFileSync(join(clone, 'b.txt'), 'b\n');
    commitAll(clone, 'packet work b');
    git(clone, ['push', 'origin', 'packet']);
    git(seed, ['fetch', 'origin', 'packet', '--quiet']);
    git(seed, ['cherry-pick', firstCommit]);
    git(seed, ['push', 'origin', 'main']);
    const lane = seedPacket(clone, 'pkt-partial');

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 0 });

    const packet = persistedPacket('pkt-partial');
    expect(packet?.status).toBe('awaiting_review');
    expect(packet?.releaseState).toBe('pending');
    expect(getLane(lane.id)?.status).toBe('reviewing');
  }, 20_000);

  // ── Lane-only candidates (lane orphaned from live mission state) ──

  function seedLaneOnly(repoPath: string, branch = 'packet') {
    const lane = createLane({
      repoPath,
      worktreePath: repoPath,
      branch,
      baseBranch: 'main',
      runtime: 'codex',
    });
    laneIds.push(lane.id);
    setLaneStatus(lane.id, 'reviewing', 'system', 'ready_for_review');
    // Live mission state has NO packets — the lane is orphaned.
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    return lane;
  }

  it('archives an orphaned lane whose branch was squash-merged (no live packet)', async () => {
    const { clone, seed } = makeRepo('o8-lane-only-squash');
    writeFileSync(join(clone, 'a.txt'), 'a\n');
    commitAll(clone, 'lane work a');
    git(clone, ['push', 'origin', 'packet']);
    git(seed, ['fetch', 'origin', 'packet', '--quiet']);
    git(seed, ['merge', '--squash', 'origin/packet']);
    commitAll(seed, 'squash lane work');
    git(seed, ['push', 'origin', 'main']);

    const lane = seedLaneOnly(clone);

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 1 });
    expect(getLane(lane.id)?.status).toBe('archived');
  }, 20_000);

  it('archives an orphaned lane whose branch no longer exists anywhere', async () => {
    const { clone } = makeRepo('o8-lane-only-branch-gone');
    // Lane records a branch that resolves nowhere — the worktree that held
    // it was pruned after a manual squash-merge. Repo itself is healthy.
    const lane = seedLaneOnly(clone, 'agent/deleted-after-manual-merge');

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 1 });
    expect(getLane(lane.id)).toMatchObject({ status: 'archived', outcome: 'no_changes' });
  }, 20_000);

  it('finishes an orphaned branch at the base head as no changes instead of merged', async () => {
    const { clone } = makeRepo('o8-lane-only-no-commits');
    const lane = seedLaneOnly(clone);

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 1 });
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived',
      outcome: 'no_changes',
      outcomeNote: 'Agent finished without making changes',
    });
  }, 20_000);

  it('never touches an orphaned lane with unmerged branch content', async () => {
    const { clone } = makeRepo('o8-lane-only-unmerged');
    writeFileSync(join(clone, 'wip.txt'), 'wip\n');
    commitAll(clone, 'unmerged lane work');
    const lane = seedLaneOnly(clone);

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 0 });
    expect(getLane(lane.id)?.status).toBe('reviewing');
  }, 20_000);

  it('never touches an active (running) orphaned lane even with branch gone', async () => {
    const { clone } = makeRepo('o8-lane-only-running');
    const lane = createLane({
      repoPath: clone,
      worktreePath: clone,
      branch: 'agent/still-being-created',
      baseBranch: 'main',
      runtime: 'codex',
    });
    laneIds.push(lane.id);
    setLaneStatus(lane.id, 'running', 'system', 'agent_working');
    writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({ merged: 0 });
    expect(getLane(lane.id)?.status).toBe('running');
  }, 20_000);

  it('keeps an awaiting packet whose isolated worker branch and owned transcript are still live', async () => {
    const { root, origin, clone } = makeRepo('o8-live-isolated-clone');
    const workerClone = join(root, 'worker-clone');
    const branch = 'issue/1622-live-isolated-clone';
    const packetId = 'pkt-1622-live-isolated-clone';
    const sessionKey = 'claude-code-owned:issue-1622-live-isolated-clone';

    execFileSync('git', ['clone', origin, workerClone], { stdio: 'pipe' });
    git(workerClone, ['checkout', '-b', 'main', 'origin/main']);
    git(workerClone, ['checkout', '-b', branch]);
    writeFileSync(join(workerClone, 'active.txt'), 'worker is still producing output\n');
    commitAll(workerClone, 'active worker commit');

    const lane = createLane({
      repoPath: clone,
      worktreePath: workerClone,
      branch,
      baseBranch: 'main',
      runtime: 'claude-code',
      sessionKey,
      packetId,
    });
    laneIds.push(lane.id);
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'worker_turn_active');
    writeFreshClaudeTranscript(sessionKey);
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-1622-live-isolated-clone',
      repoPath: clone,
      packets: [packetFixture(clone, packetId, lane.id, {
        branch,
        runtime: 'claude-code',
        sessionKey,
      })],
    });

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({
      scanned: 1,
      merged: 0,
      skipped: 1,
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_input',
      outcome: null,
      worktreePath: workerClone,
    });
    expect(persistedPacket(packetId)).toMatchObject({
      status: 'awaiting_review',
      releaseState: 'pending',
    });
  }, 20_000);

  it('keeps an awaiting packet when its owned transcript cannot be resolved', async () => {
    const { clone } = makeRepo('o8-live-owned-transcript-unknown');
    const branch = 'issue/1622-owned-transcript-unknown';
    const packetId = 'pkt-1622-owned-transcript-unknown';
    const sessionKey = 'claude-code-owned:issue-1622-owned-transcript-unknown';

    const lane = createLane({
      repoPath: clone,
      worktreePath: clone,
      branch,
      baseBranch: 'main',
      runtime: 'claude-code',
      sessionKey,
      packetId,
    });
    laneIds.push(lane.id);
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'worker_liveness_unknown');
    writeOrchestratorControlPlaneState({
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-1622-owned-transcript-unknown',
      repoPath: clone,
      packets: [packetFixture(clone, packetId, lane.id, {
        branch,
        runtime: 'claude-code',
        sessionKey,
      })],
    });

    await expect(sweepPacketsMergedByAncestry()).resolves.toMatchObject({
      scanned: 1,
      merged: 0,
      skipped: 1,
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_input',
      outcome: null,
      sessionKey,
    });
  }, 20_000);

  it('refuses branch preparation that would reset a fresh sibling mission lane', async () => {
    const { clone } = makeRepo('o8-live-branch-preparation');
    const branch = 'issue/1622-live-branch-preparation';
    const packetId = 'pkt-1622-live-branch-preparation';
    const sessionKey = 'claude-code-owned:issue-1622-live-branch-preparation';
    git(clone, ['branch', branch, 'main']);

    const lane = createLane({
      repoPath: clone,
      worktreePath: clone,
      branch,
      baseBranch: 'main',
      runtime: 'claude-code',
      sessionKey,
      packetId,
    });
    laneIds.push(lane.id);
    setLaneStatus(lane.id, 'awaiting_input', 'system', 'worker_turn_active');
    writeFreshClaudeTranscript(sessionKey);

    await expect(prepareMissionBranches({
      repoPath: clone,
      candidates: [{
        issue: {
          number: 1622,
          title: 'Keep a live sibling lane',
          body: 'Do not archive a lane with fresh transcript activity.',
          url: 'https://github.com/hurttlocker/o8/issues/1622',
        },
        branchTarget: branch,
      }],
      previousPackets: [],
      existingBranchPolicy: 'reset',
    })).rejects.toThrow(/live or unknown sibling lane liveness/);

    expect(getLane(lane.id)).toMatchObject({
      status: 'awaiting_input',
      packetId,
      worktreePath: clone,
    });
    expect(() => git(clone, ['rev-parse', '--verify', `refs/heads/${branch}`])).not.toThrow();
  }, 20_000);
});
