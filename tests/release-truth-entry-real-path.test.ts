import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

// Cleanup has its own real-path suite. Keep these Git fixtures until assertions finish.
vi.mock('@/lib/lane/terminal-lane-cleanup', () => ({ scheduleTerminalLaneCleanup: vi.fn() }));
const dataDir = mkdtempSync(join(tmpdir(), 'o8-release-entry-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const roots = [dataDir];
const { closeDb } = await import('@/lib/db');
const control = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { approveAndMergePacket } = await import('@/lib/orchestrator/operator-mission-service/merge');
const { alreadyReleasedResultForPacket, alreadyReleasedResultForPacketId } = await import('@/lib/orchestrator/operator-mission-service/release-truth');
let sequence = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commit(cwd: string, content: string): string {
  writeFileSync(join(cwd, 'app.txt'), `${content}\n`);
  git(cwd, 'add', 'app.txt');
  git(cwd, 'commit', '-qm', 'fixture');
  return git(cwd, 'rev-parse', 'HEAD');
}

function persist(packet: OrchestratorPacket, repoPath: string): OrchestratorPacket {
  control.writeOrchestratorControlPlaneState({ ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${packet.id}`, repoPath, packets: [packet] });
  return control.readOrchestratorControlPlaneState().packets[0];
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'o8-release-git-'));
  roots.push(root);
  const repoPath = join(root, 'repo');
  const worktreePath = join(root, 'worktree');
  const id = `packet-release-${++sequence}`;
  const branch = `inline/${id}`;
  git(root, 'init', '-qb', 'main', repoPath);
  git(repoPath, 'config', 'user.name', 'o8-test');
  git(repoPath, 'config', 'user.email', 'test@example.test');
  const base = commit(repoPath, 'base');
  git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath);
  const lane = createLane({ repoPath, worktreePath, branch, baseBranch: 'main', runtime: 'codex', packetId: id });
  setLaneStatus(lane.id, 'completed', 'system');
  const packet = persist({ id, title: id, summary: id, referenceLabel: id, runtime: 'codex',
    workspaceTargetPath: repoPath, branchTarget: branch, dependencyLabels: [], dependencyPacketIds: [],
    status: 'released', queueState: 'held', releaseState: 'released', attemptCount: 1,
    releaseStatePayload: { source: 'approve_and_merge', evidenceKind: 'merge_command',
      mergeCommit: base, headSha: base, releasedAt: '2026-09-10T00:00:00.000Z' },
    review: { approved: false, summary: 'Review still required', findings: [], recordedAt: '2026-09-10T00:00:00.000Z' },
    lane: { laneId: lane.id, tileId: lane.id, tabId: lane.id, repoPath, worktreePath, runtime: 'codex' },
  }, repoPath);
  return { repoPath, worktreePath, lane: getLane(lane.id)!, packet, base, branch };
}

afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  closeDb();
  for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
});

describe('release truth through the merge service and persisted packet state', () => {
  it('does not let a terminal lane event resurrect a stale packet receipt', async () => {
    const f = fixture();
    recordLaneEvent(f.lane.id, 'merge', 'system', { laneHeadSha: f.base });
    commit(f.worktreePath, 'unmerged successor');
    const result = await approveAndMergePacket({ packetId: f.packet.id });
    expect(result.merged).toBe(false);
    expect(result.alreadyReleased).not.toBe(true);
    expect(control.readOrchestratorControlPlaneState().packets[0].releaseState).toBe('pending');
    expect(git(f.repoPath, 'rev-parse', 'main')).toBe(f.base);
  });

  it('checks the target branch even when the repository checkout itself contains the work', async () => {
    const f = fixture();
    const head = commit(f.worktreePath, 'not on target');
    git(f.repoPath, 'checkout', '--detach', head);
    expect(await approveAndMergePacket({ packetId: f.packet.id })).toMatchObject({ merged: false });
    expect(git(f.repoPath, 'rev-parse', 'main')).toBe(f.base);
  });

  it('reads the real worktree HEAD when it has detached from the recorded branch', async () => {
    const f = fixture();
    git(f.worktreePath, 'checkout', '--detach');
    commit(f.worktreePath, 'detached successor');
    expect(await approveAndMergePacket({ packetId: f.packet.id })).toMatchObject({ merged: false });
    expect(control.readOrchestratorControlPlaneState().packets[0].releaseState).toBe('pending');
  });

  it('does not hide uncommitted work behind a previously merged HEAD', async () => {
    const f = fixture();
    writeFileSync(join(f.worktreePath, 'app.txt'), 'uncommitted successor\n');
    expect(await approveAndMergePacket({ packetId: f.packet.id })).toMatchObject({ merged: false });
    expect(git(f.worktreePath, 'status', '--porcelain')).not.toBe('');
  });

  it('preserves a genuine clean merge receipt', async () => {
    const f = fixture();
    const head = commit(f.worktreePath, 'merged work');
    git(f.repoPath, 'merge', '--ff-only', f.branch);
    persist({ ...f.packet, releaseStatePayload: { ...f.packet.releaseStatePayload, mergeCommit: head, headSha: head } }, f.repoPath);
    expect(await approveAndMergePacket({ packetId: f.packet.id })).toMatchObject({
      merged: true, alreadyReleased: true, mergeSha: head, ancestryVerified: true,
    });
  });

  it('accepts a recorded squash merge of the same HEAD but rejects a later successor', async () => {
    const f = fixture();
    const head = commit(f.worktreePath, 'squashed work');
    git(f.repoPath, 'merge', '--squash', f.branch);
    git(f.repoPath, 'commit', '-qm', 'squash receipt');
    const mergeSha = git(f.repoPath, 'rev-parse', 'HEAD');
    persist({ ...f.packet, releaseStatePayload: { ...f.packet.releaseStatePayload, mergeCommit: mergeSha, headSha: head } }, f.repoPath);
    expect(await approveAndMergePacket({ packetId: f.packet.id })).toMatchObject({
      merged: true, alreadyReleased: true, mergeSha,
    });
    commit(f.worktreePath, 'unmerged after squash');
    expect(await approveAndMergePacket({ packetId: f.packet.id })).toMatchObject({ merged: false });
  });

  it('keeps a genuine release readable after its merged worktree and branch are removed', async () => {
    const f = fixture();
    const head = commit(f.worktreePath, 'merged and cleaned');
    git(f.repoPath, 'merge', '--ff-only', f.branch);
    persist({ ...f.packet, releaseStatePayload: { ...f.packet.releaseStatePayload, mergeCommit: head, headSha: head } }, f.repoPath);
    git(f.repoPath, 'worktree', 'remove', f.worktreePath);
    git(f.repoPath, 'branch', '-d', f.branch);
    expect(await approveAndMergePacket({ packetId: f.packet.id })).toMatchObject({
      merged: true, alreadyReleased: true, mergeSha: head,
    });
  });

  it('allows a genuine lane-only merge event but not a generic completion event', async () => {
    const f = fixture();
    const head = commit(f.worktreePath, 'landed orphan');
    git(f.repoPath, 'merge', '--ff-only', f.branch);
    control.writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
    recordLaneEvent(f.lane.id, 'status_change', 'system', { status: 'completed', laneHeadSha: head });
    expect(await alreadyReleasedResultForPacketId(f.packet.id, [])).toBeNull();
    recordLaneEvent(f.lane.id, 'merge', 'system', { laneHeadSha: head });
    expect(await alreadyReleasedResultForPacketId(f.packet.id, [])).toMatchObject({ merged: true, mergeSha: head });
  });

  it('does not apply a completed sibling lane to the currently bound recovery lane', async () => {
    const f = fixture();
    const head = commit(f.worktreePath, 'new recovery work');
    const old = createLane({ repoPath: f.repoPath, branch: 'main', baseBranch: 'main',
      runtime: 'codex', packetId: f.packet.id });
    setLaneStatus(old.id, 'completed', 'system');
    recordLaneEvent(old.id, 'merge', 'system', { laneHeadSha: f.base });
    const packet = persist({ ...f.packet, releaseState: 'pending', releaseStatePayload: null,
      status: 'awaiting_review' }, f.repoPath);
    expect(await alreadyReleasedResultForPacketId(packet.id, [packet])).toBeNull();
    expect(git(f.worktreePath, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('fails closed when a worktree exists but its HEAD cannot be read', async () => {
    const f = fixture();
    // An existing non-repository directory is not evidence of successful cleanup.
    const invalid = mkdtempSync(join(tmpdir(), 'o8-unreadable-release-'));
    roots.push(invalid);
    expect(await alreadyReleasedResultForPacket(f.packet, { ...f.lane, worktreePath: invalid })).toBeNull();
  });

  it('does not mistake another local branch for the release target', async () => {
    const f = fixture();
    git(f.repoPath, 'branch', 'stable', f.base);
    const head = commit(f.worktreePath, 'only on main');
    git(f.repoPath, 'merge', '--ff-only', f.branch);
    const packet = persist({ ...f.packet, releaseStatePayload: { ...f.packet.releaseStatePayload, mergeCommit: head, headSha: head } }, f.repoPath);
    expect(await alreadyReleasedResultForPacket(packet, { ...f.lane, baseBranch: 'stable' })).toBeNull();
  });

  it.each(['stop', 'archive'] as const)('keeps the %s boundary while clearing stale release evidence', async (hold) => {
    const f = fixture();
    commit(f.worktreePath, 'unmerged');
    const packet = persist({ ...f.packet, status: hold === 'archive' ? 'archived' : 'blocked',
      operatorStopped: hold === 'stop', archivedAt: hold === 'archive' ? '2026-09-10T00:01:00.000Z' : null,
      blockedReason: 'operator hold' }, f.repoPath);
    expect(await alreadyReleasedResultForPacket(packet, f.lane)).toBeNull();
    expect(control.readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      releaseState: 'pending', status: packet.status, queueState: 'held',
      operatorStopped: packet.operatorStopped, archivedAt: packet.archivedAt,
    });
  });

  it('does not overwrite a newer receipt while an older Git check waits for the state lock', async () => {
    const f = fixture();
    const head = commit(f.worktreePath, 'successor');
    const lockedWrite = vi.spyOn(control, 'withLockedState');
    let checking!: ReturnType<typeof alreadyReleasedResultForPacket>;
    let fresh!: OrchestratorPacket;
    await control.withControlPlaneLock(async () => {
      checking = alreadyReleasedResultForPacket(f.packet, f.lane);
      await vi.waitFor(() => expect(lockedWrite).toHaveBeenCalled());
      git(f.repoPath, 'merge', '--ff-only', f.branch);
      fresh = persist({ ...f.packet, attemptCount: 2, releaseStatePayload: {
        ...f.packet.releaseStatePayload, mergeCommit: head, headSha: head, releasedAt: '2026-09-10T00:02:00.000Z',
      } }, f.repoPath);
    });
    expect(await checking).toBeNull();
    expect(control.readOrchestratorControlPlaneState().packets[0]).toMatchObject({
      releaseState: fresh.releaseState, releaseStatePayload: fresh.releaseStatePayload,
      attemptCount: fresh.attemptCount, status: fresh.status, queueState: fresh.queueState,
    });
  });
});
