import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { GitHubPullRequestSnapshot } from '@/lib/github-broker/store';

vi.mock('@/lib/lane/terminal-lane-cleanup', () => ({ scheduleTerminalLaneCleanup: vi.fn() }));
vi.mock('@/lib/lane/worktree-cleanup', () => ({ pruneRepoWorktrees: vi.fn(async () => []) }));
vi.mock('@/lib/github-broker/sync', () => ({
  ensureGitHubPullRequest: vi.fn(async () => ({ pr: null })),
  ensureGitHubPullRequestByHead: vi.fn(async () => ({ pr: null })),
}));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: vi.fn(async () => ({ agents: [] })) }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn(async () => {}) }));
vi.mock('@/lib/lane/durable-review-approval', () => ({ hasDurableApprovedReview: vi.fn(async () => true) }));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-automatic-release-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const roots = [dataDir];
const { closeDb } = await import('@/lib/db');
const { createLane, getLane, updateLane } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { recordMission } = await import('@/lib/db/missions-store');
const { upsertGitHubPullRequest } = await import('@/lib/github-broker/store');
const { runWorktreeReaperTick } = await import('@/lib/lane/worktree-reaper');
const control = await import('@/lib/orchestrator/control-plane');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { createEmptyOrchestratorMissionState, packetReleaseBlockedBy } = await import('@/lib/orchestrator/store');
const { releaseMergedPullRequestPacket } = await import('@/lib/orchestrator/automatic-release');
const { runHeadlessSprintTick } = await import('@/lib/orchestrator/headless-loop');
const { hasDurableApprovedReview } = await import('@/lib/lane/durable-review-approval');
const { runAwaitingReviewAutoReleaseSweep } = await import('@/lib/supervisor/heal-bot-auto-release');
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

function fixture(location: 'current' | 'registry' = 'current') {
  const root = mkdtempSync(join(tmpdir(), 'o8-auto-release-git-'));
  roots.push(root);
  const repoPath = join(root, 'repo'), worktreePath = join(root, 'worktree');
  const number = ++sequence, packetId = `pkt-auto-release-${number}`, branch = `inline/${packetId}`;
  git(root, 'init', '-qb', 'main', repoPath);
  git(repoPath, 'config', 'user.name', 'o8-test');
  git(repoPath, 'config', 'user.email', 'test@example.test');
  git(repoPath, 'remote', 'add', 'origin', `https://github.com/example/release-${number}.git`);
  commit(repoPath, 'base');
  git(repoPath, 'worktree', 'add', '-qb', branch, worktreePath);
  const headSha = commit(worktreePath, 'merged work');
  git(repoPath, 'merge', '--squash', branch);
  git(repoPath, 'commit', '-qm', 'merged fixture');
  const mergeCommit = git(repoPath, 'rev-parse', 'HEAD');
  const lane = createLane({ repoPath, worktreePath, branch, baseBranch: 'main', runtime: 'codex', packetId });
  updateLane(lane.id, { status: 'reviewing', prNumber: number }, 'system');
  const packet: OrchestratorPacket = { id: packetId, referenceLabel: packetId, title: packetId, summary: packetId,
    runtime: 'codex', workspaceTargetPath: repoPath, branchTarget: branch, dependencyLabels: [], dependencyPacketIds: [],
    queueState: 'held', releaseState: 'pending', status: 'awaiting_review', attemptCount: 1,
    lane: { laneId: lane.id, tileId: lane.id, tabId: lane.id, repoPath, worktreePath, runtime: 'codex' },
  };
  const dependent = { ...packet, id: `${packetId}-next`, referenceLabel: `${packetId}-next`, title: 'Dependent work', lane: null,
    status: 'queued' as const, queueState: 'queued' as const, dependencyPacketIds: [packetId] };
  const mission: OrchestratorMissionState = { ...createEmptyOrchestratorMissionState(),
    missionId: `mission-${packetId}`, repoPath, packets: [packet, dependent] };
  const persist = () => {
    control.writeOrchestratorControlPlaneState(location === 'current' ? mission : createEmptyOrchestratorMissionState());
    if (location === 'registry') recordMission({ id: mission.missionId!, repoPath, runtime: 'codex',
      prompt: 'release fixture', summary: 'release fixture', constraints: '', packetMeta: [], totalWaves: 2, missionState: mission });
  };
  persist();
  const read = () => location === 'current' ? control.readOrchestratorControlPlaneState()
    : readMissionRegistryEntry(mission.missionId!, { includeArchived: true })!.mission;
  const pull: GitHubPullRequestSnapshot = { pullRequestId: number, repoFullName: `example/release-${number}`,
    number, title: 'fixture', state: 'closed', author: null, body: '', headRefName: branch, baseRefName: 'main',
    additions: 1, deletions: 0, changedFiles: 1, reviewDecision: null, statusCheckRollup: [], url: 'https://example.test/pr',
    createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:02:00Z', closedAt: '2026-09-10T00:02:00Z',
    mergedAt: '2026-09-10T00:02:00Z', headSha, mergeCommit };
  upsertGitHubPullRequest(pull);
  return { repoPath, worktreePath, lane: getLane(lane.id)!, packet, mission, pull, persist, read };
}

afterEach(() => vi.restoreAllMocks());
afterAll(() => { closeDb(); for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true }); });

describe('automatic PR release through the real reaper and durable missions', () => {
  it.each(['current', 'new-steer'] as const)('pins the approved ancestry auto-release to %s work', async (mode) => {
    const f = fixture();
    git(f.repoPath, 'merge', '--no-ff', '-m', 'fixture merge', f.lane.branch);
    git(f.repoPath, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    updateLane(f.lane.id, { lastEventAt: '2026-01-01T00:00:00Z' }, 'system');
    vi.mocked(hasDurableApprovedReview).mockImplementationOnce(async () => {
      if (mode === 'new-steer') recordLaneEvent(f.lane.id, 'steered_packet', 'user', { message: 'new work' });
      return true;
    });
    await runAwaitingReviewAutoReleaseSweep();
    if (mode === 'new-steer') {
      expect(f.read().packets[0].releaseState).toBe('pending');
      expect(getLane(f.lane.id)?.status).toBe('reviewing');
    } else {
      expect(f.read().packets[0].releaseStatePayload).toMatchObject({
        source: 'heal_bot_auto_release', headSha: f.pull.headSha, mergeCommit: git(f.repoPath, 'rev-parse', 'HEAD'),
      });
    }
  });

  it.each(['current', 'registry'] as const)('releases proved %s work and unblocks its sequential dependent', async (location) => {
    const f = fixture(location);
    expect(packetReleaseBlockedBy(f.mission.packets[1], f.mission.packets)?.id).toBe(f.packet.id);
    await runWorktreeReaperTick();
    await runHeadlessSprintTick();
    const saved = f.read();
    expect(saved.packets[0]).toMatchObject({ releaseState: 'released', releaseStatePayload: {
      source: 'headless_released', evidenceKind: 'pull_request_merged', headSha: f.pull.headSha, mergeCommit: f.pull.mergeCommit,
    } });
    expect(packetReleaseBlockedBy(saved.packets[1], saved.packets)).toBeNull();
    expect(saved.packets[1].blockedReason ?? '').not.toContain('explicitly released');
    expect(getLane(f.lane.id)?.status).toBe('archived');
  });

  it.each(['current', 'registry'] as const)('preserves a newer unmerged commit in a %s mission', async (location) => {
    const f = fixture(location);
    const successor = commit(f.worktreePath, 'unmerged successor');
    await runWorktreeReaperTick();
    expect(f.read().packets[0].releaseState).toBe('pending');
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
    expect(git(f.worktreePath, 'rev-parse', 'HEAD')).toBe(successor);
  });

  it.each(['stop', 'archive', 'running', 'missing-proof', 'dirty'] as const)('refuses automatic release for %s', async (reason) => {
    const f = fixture();
    if (reason === 'stop') f.packet.operatorStopped = true;
    if (reason === 'archive') f.packet.archivedAt = new Date().toISOString();
    if (reason === 'running') f.packet.status = 'running';
    if (reason === 'missing-proof') upsertGitHubPullRequest({ ...f.pull, headSha: null, mergeCommit: null });
    if (reason === 'dirty') writeFileSync(join(f.worktreePath, 'app.txt'), 'dirty successor');
    f.persist();
    await runWorktreeReaperTick();
    expect(f.read().packets[0].releaseState).toBe('pending');
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
  });

  it('refuses a delayed release after a new steer enters the same lane', async () => {
    const f = fixture();
    const lockedWrite = vi.spyOn(control, 'withLockedState');
    let releasing!: ReturnType<typeof releaseMergedPullRequestPacket>;
    await control.withControlPlaneLock(async () => {
      releasing = releaseMergedPullRequestPacket(f.lane, f.pull);
      await vi.waitFor(() => expect(lockedWrite).toHaveBeenCalled());
      recordLaneEvent(f.lane.id, 'steered_packet', 'user', { message: 'new work' });
    });
    expect(await releasing).toBe('held');
    expect(f.read().packets[0].releaseState).toBe('pending');
  });

  it('can finish archiving after release was persisted by an interrupted reaper', async () => {
    const f = fixture();
    expect(await releaseMergedPullRequestPacket(f.lane, f.pull)).toBe('released');
    expect(getLane(f.lane.id)?.status).toBe('reviewing');
    await runWorktreeReaperTick();
    expect(getLane(f.lane.id)?.status).toBe('archived');
    expect(f.read().packets[0].releaseStatePayload?.headSha).toBe(f.pull.headSha);
  });

  it('does not archive when Stop wins the lock after Git proof was captured', async () => {
    const f = fixture();
    const archived = vi.fn();
    let releasing!: ReturnType<typeof releaseMergedPullRequestPacket>;
    await control.withControlPlaneLock(async () => {
      releasing = releaseMergedPullRequestPacket(f.lane, f.pull, archived);
      f.packet.operatorStopped = true;
      f.persist();
    });
    expect(await releasing).toBe('held');
    expect(archived).not.toHaveBeenCalled();
    expect(f.read().packets[0].operatorStopped).toBe(true);
  });
});
