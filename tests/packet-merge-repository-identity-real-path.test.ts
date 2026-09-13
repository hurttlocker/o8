/**
 * #2308 — an approved packet merges into ITS OWN repository, not the ambient
 * mission's.
 *
 * `dispatchPacketMerge` resolved the merge's canonical repository from
 * `currentMissionState().repoPath` FIRST. That value belongs to whichever
 * mission the control plane currently holds, not to the packet being merged:
 * `/api/orchestrator/delegate` pushes a dispatched packet (carrying its own
 * `workspaceTargetPath`) into the current mission state and only sets
 * `current.repoPath` when it is still unset. A packet dispatched into repo B
 * while the control plane holds a mission for repo A therefore merged against
 * A — locking, integration, publication and evidence all aimed at A.
 *
 * When A and B share history (two registered checkouts of the same origin —
 * the ordinary operator setup) every earlier merge stage passes against A:
 * the rebase succeeds, the push lease is safe, the gate reports green. The
 * first thing that notices is #2264's pre-publication evidence capture, which
 * scans `listLanes()` for the packet lane inside the repository it was handed,
 * finds none, and throws "Merge evidence capture found no durable packet lane."
 * The lane rolls back to `reviewing` with a persisted `merge_error`, and the
 * packet's own default branch never advances — the reported #2308 shape.
 *
 * Reachability rule: every case drives `approveAndMergePacket` — the entry point
 * auto-review uses — against persisted mission, packet, lane, worktree-metadata
 * and repo-registry state, with real disposable repos and a local bare push
 * remote. No listLanes mock, no fabricated snapshot, no orphan fallback.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const { recordMission } = await import('@/lib/db/missions-store');
const { createLane, getLane, getLaneEvents, setLaneStatus } = await import('@/lib/lane/registry');
const {
  approveAndMergePacket,
  submitPacketReview,
} = await import('@/lib/orchestrator/operator-mission-service');
const {
  withLockedState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { addRepo } = await import('@/lib/repos/registry');
const { captureWorktreeMaterializationIdentity } = await import('@/lib/worktree/materialization-identity');
const { withWorktreeMetaTransaction } = await import('@/lib/worktree/metadata-store');
const { worktreeRepoKey } = await import('@/lib/worktree/root-layout');
const {
  listWorkspaceSnapshotTransitions,
  listWorkspaceSnapshotsByOriginalPath,
} = await import('@/lib/worktree/snapshot-state');

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
  git(cwd, ['-c', 'user.name=o8-test', '-c', 'user.email=o8@example.test', 'commit', '-m', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

interface RepoFixture {
  origin: string;
  repoPath: string;
  baseSha: string;
}

/**
 * Two registered checkouts of ONE origin: the packet's target repository and an
 * unrelated-to-this-packet repository the control plane happens to hold. Shared
 * history is what lets a misaimed merge pass every rebase/push-lease stage, so
 * the wrong repository choice reaches evidence capture instead of failing early.
 */
async function makeSharedOriginRepos(label: string): Promise<{
  origin: string;
  target: RepoFixture;
  ambient: RepoFixture;
}> {
  const root = realpathSync(mkdtempSync(join(os.tmpdir(), `o8-2308-${label}-`)));
  roots.push(root);
  const origin = join(root, 'github-like.git');
  const targetPath = join(root, 'target');
  const ambientPath = join(root, 'ambient');
  execFileSync('git', ['init', '--bare', origin], { stdio: 'pipe' });
  execFileSync('git', ['clone', origin, targetPath], { stdio: 'pipe' });
  git(targetPath, ['checkout', '-b', 'main']);
  git(targetPath, ['config', 'user.name', 'o8-test']);
  git(targetPath, ['config', 'user.email', 'o8@example.test']);
  writeFileSync(join(targetPath, 'base.txt'), 'base\n');
  const baseSha = commitAll(targetPath, 'base');
  git(targetPath, ['push', '-u', 'origin', 'main']);
  execFileSync('git', ['clone', origin, ambientPath], { stdio: 'pipe' });
  git(ambientPath, ['checkout', '-B', 'main', 'origin/main']);
  git(ambientPath, ['config', 'user.name', 'o8-test']);
  git(ambientPath, ['config', 'user.email', 'o8@example.test']);

  await addRepo(realpathSync.native(targetPath));
  await addRepo(realpathSync.native(ambientPath));
  return {
    origin,
    target: { origin, repoPath: targetPath, baseSha },
    ambient: { origin, repoPath: ambientPath, baseSha: git(ambientPath, ['rev-parse', 'main']) },
  };
}

interface PacketFixture {
  packetId: string;
  branch: string;
  workspacePath: string;
  reviewedHeadSha: string;
  featureFile: string;
  laneId: string;
  worktreeId: string;
  packet: OrchestratorPacket;
}

/**
 * Persist ONE packet the way a dispatch into `target` leaves it: a manager-owned
 * relocated clone under the target's worktree root, worktree metadata owned by
 * the target repository, and a durable lane bound to the target repository.
 * `declaredTargetPath` is what the packet CLAIMS as its workspace target, so a
 * genuinely mismatched packet/lane pair can be exercised too.
 */
async function persistDispatchedPacket(
  target: RepoFixture,
  label: string,
  index: number,
  declaredTargetPath: string = target.repoPath,
): Promise<PacketFixture> {
  const packetId = `pkt-2308-${label}-${index}-${Date.now()}`;
  const branch = `issue/2308-${label}-${index}-${Date.now()}`;
  const relocatedBase = join(
    process.env.CORTEX_IDE_DATA_DIR!,
    'worktrees',
    worktreeRepoKey(target.repoPath),
    '.cortex-worktrees',
  );
  mkdirSync(relocatedBase, { recursive: true });
  const workspacePath = join(relocatedBase, `packet-${packetId}`);
  execFileSync('git', ['clone', target.origin, workspacePath], { stdio: 'pipe' });
  git(workspacePath, ['checkout', '-b', branch, 'origin/main']);
  git(workspacePath, ['config', 'user.name', 'o8-test']);
  git(workspacePath, ['config', 'user.email', 'o8@example.test']);
  const featureFile = `feature-${label}-${index}.txt`;
  writeFileSync(join(workspacePath, featureFile), `${label}-${index}\n`);
  const reviewedHeadSha = commitAll(workspacePath, `feat: ${label} ${index} [via-o8]`);

  const worktreeId = `packet-${packetId}`;
  const materializationIdentity = await captureWorktreeMaterializationIdentity(workspacePath);
  const materializationParentIdentity = await captureWorktreeMaterializationIdentity(relocatedBase);
  await withWorktreeMetaTransaction(target.repoPath, (transaction) => transaction.save(worktreeId, {
    id: worktreeId,
    agentType: 'codex',
    sessionKey: `codex:${packetId}`,
    baseBranch: 'main',
    createdAt: Date.now(),
    claudeManaged: false,
    taskName: `Dispatched ${label} ${index}`,
    branchName: branch,
    status: 'ready',
    isolationKind: 'apfs-cow-clone',
    materializationIdentity,
    materializationParentIdentity,
  }));

  const lane = createLane({
    repoPath: target.repoPath,
    worktreePath: workspacePath,
    branch,
    baseBranch: 'main',
    runtime: 'codex',
    packetId,
    sessionKey: `codex:${packetId}`,
    label: `Dispatched ${label} ${index}`,
  });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_ready');

  return {
    packetId,
    branch,
    workspacePath,
    reviewedHeadSha,
    featureFile,
    laneId: lane.id,
    worktreeId,
    packet: {
      id: packetId,
      referenceLabel: `PKT-${label.toUpperCase()}-${index}`,
      title: `dispatch ${label} ${index}`,
      summary: 'Exercise packet-owned canonical merge publication.',
      status: 'awaiting_review',
      queueState: 'queued',
      releaseState: 'pending',
      workspaceTargetPath: declaredTargetPath,
      branchTarget: branch,
      runtime: 'codex',
      dependencyPacketIds: [],
      dependencyLabels: [],
      blockedReason: null,
      lane: null,
      review: null,
      lastEventAt: null,
      lastEventLabel: null,
    } as OrchestratorPacket,
  };
}

/**
 * Mirror the delegate route's persisted shape: the control plane holds a mission
 * for `missionRepo`, and dispatched packets for other repositories are appended
 * to that same state (`current.repoPath` is only set when still unset).
 */
async function holdMissionForRepo(missionRepo: RepoFixture, label: string) {
  const missionId = `mission-2308-${label}-${Date.now()}`;
  const mission: OrchestratorMissionState = {
    ...createEmptyOrchestratorMissionState(),
    missionId,
    repoPath: missionRepo.repoPath,
    prompt: 'Ambient mission held by the control plane',
    summary: 'Ambient mission held by the control plane',
    packets: [],
    updatedAt: new Date().toISOString(),
  };
  recordMission({
    id: missionId,
    repoPath: missionRepo.repoPath,
    runtime: 'codex',
    prompt: mission.prompt,
    summary: mission.summary,
    constraints: '',
    packetMeta: [],
    missionState: mission,
    totalWaves: 1,
  });
  writeOrchestratorControlPlaneState(mission);
  return missionId;
}

async function appendDispatchedPackets(packets: PacketFixture[]) {
  await withLockedState((current) => {
    for (const entry of packets) {
      if (!current.packets.some((candidate) => candidate.id === entry.packet.id)) {
        current.packets.push(entry.packet);
      }
    }
    current.updatedAt = new Date().toISOString();
  });
}

async function reviewAndMerge(fixture: PacketFixture, expectedHeadSha = fixture.reviewedHeadSha) {
  await submitPacketReview({
    packetId: fixture.packetId,
    approved: true,
    findings: [],
    reviewedHeadSha: fixture.reviewedHeadSha,
  });
  return approveAndMergePacket({
    packetId: fixture.packetId,
    expectedHeadSha,
    actor: 'user',
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('#2308 approved packets merge into their own repository', () => {
  it('lands three approved packets on the target default branch while the ambient mission repository holds still', async () => {
    const { target, ambient } = await makeSharedOriginRepos('parallel');
    await holdMissionForRepo(ambient, 'parallel');
    const packets = [
      await persistDispatchedPacket(target, 'parallel', 1),
      await persistDispatchedPacket(target, 'parallel', 2),
      await persistDispatchedPacket(target, 'parallel', 3),
    ];
    await appendDispatchedPackets(packets);

    for (const fixture of packets) {
      const result = await reviewAndMerge(fixture);

      expect({ packetId: fixture.packetId, merged: result.merged, note: result.note })
        .toMatchObject({ packetId: fixture.packetId, merged: true });
      // Packets 2 and 3 were cut from the pre-merge base, so the landed
      // candidate is a REBASED commit distinct from the reviewed head.
      const mergeSha = result.mergeSha!;
      expect(mergeSha).toBeTruthy();
      expect(git(target.repoPath, ['merge-base', '--is-ancestor', mergeSha, 'main'])).toBe('');
      expect(git(target.repoPath, ['rev-parse', 'main'])).toBe(mergeSha);
      expect(git(target.repoPath, ['ls-tree', '-r', '--name-only', 'main'])).toContain(fixture.featureFile);

      const snapshots = listWorkspaceSnapshotsByOriginalPath(fixture.workspacePath);
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ state: 'retired', headCommit: fixture.reviewedHeadSha });
      const creation = listWorkspaceSnapshotTransitions(
        snapshots[0]!.repositoryUuid,
        snapshots[0]!.packetId,
      )[0];
      expect(creation?.receipt).toMatchObject({
        reviewedHeadSha: fixture.reviewedHeadSha,
        mergeCandidateSha: mergeSha,
      });
      // The reviewed work stays provable in the target repository after cleanup.
      expect(git(target.repoPath, ['rev-parse', snapshots[0]!.recoveryRef])).toBe(fixture.reviewedHeadSha);
      expect(existsSync(fixture.workspacePath)).toBe(false);
    }

    const landedFiles = git(target.repoPath, ['ls-tree', '-r', '--name-only', 'main']);
    for (const fixture of packets) expect(landedFiles).toContain(fixture.featureFile);
    expect(git(target.repoPath, ['rev-parse', 'main']))
      .toBe(git(target.repoPath, ['rev-parse', 'origin/main']));
    // The other registered repository the control plane happens to hold never advances.
    expect(git(ambient.repoPath, ['rev-parse', 'main'])).toBe(ambient.baseSha);
  }, 180_000);

  it('refuses with a persisted merge_error when the packet claims a repository its durable lane does not own', async () => {
    const { target, ambient } = await makeSharedOriginRepos('mismatch');
    await holdMissionForRepo(ambient, 'mismatch');
    const fixture = await persistDispatchedPacket(target, 'mismatch', 1, ambient.repoPath);
    await appendDispatchedPackets([fixture]);

    const result = await reviewAndMerge(fixture);

    expect(result.merged).toBe(false);
    expect(result.note).toMatch(/durable packet lane/i);
    expect(getLane(fixture.laneId)).toMatchObject({
      status: 'reviewing',
      lastEventLabel: 'merge_error',
    });
    expect(getLaneEvents(fixture.laneId).some((event) => (
      event.payload.eventLabel === 'merge_error'
      && typeof event.payload.reason === 'string'
      && /durable packet lane/i.test(event.payload.reason)
    ))).toBe(true);
    expect(listWorkspaceSnapshotsByOriginalPath(fixture.workspacePath)).toHaveLength(0);
    expect(git(target.repoPath, ['rev-parse', 'main'])).toBe(target.baseSha);
    expect(git(ambient.repoPath, ['rev-parse', 'main'])).toBe(ambient.baseSha);
    expect(existsSync(fixture.workspacePath)).toBe(true);
  }, 90_000);

  it('still refuses when the workspace has lost its managed ownership receipt', async () => {
    const { target, ambient } = await makeSharedOriginRepos('ownership');
    await holdMissionForRepo(ambient, 'ownership');
    const fixture = await persistDispatchedPacket(target, 'ownership', 1);
    await appendDispatchedPackets([fixture]);
    await withWorktreeMetaTransaction(
      target.repoPath,
      (transaction) => transaction.remove(fixture.worktreeId),
    );

    const result = await reviewAndMerge(fixture);

    expect(result.merged).toBe(false);
    expect(result.note).toMatch(/managed workspace/i);
    expect(listWorkspaceSnapshotsByOriginalPath(fixture.workspacePath)).toHaveLength(0);
    expect(git(target.repoPath, ['rev-parse', 'main'])).toBe(target.baseSha);
    expect(existsSync(fixture.workspacePath)).toBe(true);
  }, 90_000);

  it('keeps the reviewed head pin enforced for a dispatched packet', async () => {
    const { target, ambient } = await makeSharedOriginRepos('head-pin');
    await holdMissionForRepo(ambient, 'head-pin');
    const fixture = await persistDispatchedPacket(target, 'head-pin', 1);
    await appendDispatchedPackets([fixture]);
    const stalePin = git(fixture.workspacePath, ['rev-parse', 'HEAD~1']);

    await expect(reviewAndMerge(fixture, stalePin)).rejects.toThrow(/head/i);
    expect(git(target.repoPath, ['rev-parse', 'main'])).toBe(target.baseSha);
    expect(listWorkspaceSnapshotsByOriginalPath(fixture.workspacePath)).toHaveLength(0);
  }, 90_000);
});
