import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';

const cleanupBoundary = vi.hoisted(() => ({ check: null as ((laneId: string) => void) | null }));

vi.mock('@/lib/orchestrator/worktree-cleanup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/orchestrator/worktree-cleanup')>();
  return { ...actual, removeMergedWorktree: async (...args: Parameters<typeof actual.removeMergedWorktree>) => {
    cleanupBoundary.check?.(args[0].id);
    return actual.removeMergedWorktree(...args);
  } };
});

const retirement = vi.hoisted(() => ({ check: null as ((laneId: string) => void) | null }));

vi.mock('@/lib/lane/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/registry')>();
  return { ...actual, archiveLane: (...args: Parameters<typeof actual.archiveLane>) => {
    retirement.check?.(args[0]);
    return actual.archiveLane(...args);
  } };
});

vi.mock('@/lib/runtime/process-cwd-snapshot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/runtime/process-cwd-snapshot')>();
  return {
    ...actual,
    // The shape readProcessCwdSnapshot returns when lsof hits its 3 s timeout.
    readProcessCwdSnapshot: vi.fn(async () => {
      return {
        status: 'unavailable' as const,
        rows: [],
        capturedAt: Date.now(),
        reason: 'Command failed: lsof -nP -d cwd -F pcn (timed out)',
      };
    }),
  };
});

vi.mock('@/lib/realtime/publisher', () => ({
  publishRealtimeMutation: vi.fn(async () => {}),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  DispatchPreflightError: class extends Error {},
  assertRuntimeDispatchable: vi.fn(async () => {}),
  getRuntimeAuthSnapshot: vi.fn(async () => ({ statuses: {}, suggestedSubscriptionProfile: { profile: null, detail: null } })),
}));

const dataDir = mkdtempSync(join(os.tmpdir(), 'o8-3055-data-'));
const tempDirs: string[] = [dataDir];
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;

const { updateOperatorDefaults } = await import('@/lib/operator/defaults');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { approveAndMergePacket, resetPacket, submitPacketReview } = await import('@/lib/orchestrator/operator-mission-service');
const { prepareLaunchWorktree } = await import('@/lib/worktree/launch');

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function gitOut(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeMergeRepo(): string {
  const repoPath = mkdtempSync(join(os.tmpdir(), 'o8-3055-repo-'));
  const originPath = mkdtempSync(join(os.tmpdir(), 'o8-3055-origin-'));
  tempDirs.push(repoPath, originPath);
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.dev']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  git(originPath, ['init', '-q', '--bare']);
  git(repoPath, ['remote', 'add', 'origin', originPath]);
  git(repoPath, ['push', '-q', '-u', 'origin', 'main']);
  return repoPath;
}

const { recordMission } = await import('@/lib/db/missions-store');
const { closeDb } = await import('@/lib/db');
const { persistMissionRegistryState, readMissionRegistryEntry, withMissionRegistryState } = await import('@/lib/orchestrator/mission-registry');
const { sweepPacketsMergedByAncestry } = await import('@/lib/orchestrator/merged-by-ancestry');
const { GET } = await import('@/app/api/orchestrator/status/route');
const { NextRequest } = await import('next/server');

async function fixture(name: string) {
  await updateOperatorDefaults({ storageReserveRatio: 0.0001, storageReserveFloorGb: 0.001 });
  const repoPath = makeMergeRepo();
  const packetId = `pkt-3055-${name}`;
  const branch = `inline/3055-${name}`;
  const previous = process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
  process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';
  const launch = await prepareLaunchWorktree({ repoRoot: repoPath, agentType: 'codex',
    taskName: name, branchName: branch, baseBranch: 'main', isolate: true, skipSetup: true, packetId,
  }).finally(() => {
    if (previous === undefined) delete process.env.O8_SKIP_PRELAUNCH_TYPECHECK;
    else process.env.O8_SKIP_PRELAUNCH_TYPECHECK = previous;
  });
  const worktreePath = launch!.cwd;
  tempDirs.push(worktreePath);
  const lane = createLane({ repoPath, worktreePath, branch, baseBranch: 'main', runtime: 'codex', packetId });
  setLaneStatus(lane.id, 'reviewing', 'system', 'review_requested');
  writeFileSync(join(worktreePath, 'feature.txt'), 'feature\n');
  git(worktreePath, ['add', 'feature.txt']);
  git(worktreePath, ['commit', '-q', '-m', 'feat: durable release fixture [via-o8]']);
  const headSha = gitOut(worktreePath, ['rev-parse', 'HEAD']);
  const state = writeOrchestratorControlPlaneState({
    ...createEmptyOrchestratorMissionState(), missionId: `mission-3055-${name}`, repoPath,
    packets: [{ id: packetId, referenceLabel: 'P1', title: name, summary: name,
      status: 'awaiting_review', queueState: 'held', releaseState: 'pending',
      blockedReason: 'Merge in progress', lane: null, review: null, runtime: 'codex',
      dependencyPacketIds: [], dependencyLabels: [], attemptCount: 0,
      lastEventAt: '2026-10-01T18:21:30.344Z', lastEventLabel: 'merging',
      recoveryCount: 0, typecheckAutoRetries: 0, orchestratorThreadId: null,
      workspaceTargetPath: repoPath, branchTarget: branch,
    } as OrchestratorPacket],
  });
  recordMission({ id: state.missionId!, repoPath, runtime: 'codex', prompt: name,
    summary: name, constraints: '', packetMeta: [{ id: packetId, title: name, referenceLabel: 'P1' }],
    missionState: state, totalWaves: 1 });
  await submitPacketReview({ packetId, approved: true, findings: [], reviewedHeadSha: headSha });
  return { repoPath, packetId, lane, headSha, state };
}

async function durableApiRead(missionId: string) {
  // The caller has reopened SQLite. Move file focus away to read the durable owner.
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  const response = await GET(new NextRequest(`http://localhost/api/orchestrator/status?missionId=${missionId}`, { headers: { host: 'localhost' } }));
  expect(response.status).toBe(200);
  return (await response.json()).result;
}

function releasedRegistryFixture(name: string) {
  // A durable non-current owner exercises the production reset path without a worker.
  writeOrchestratorControlPlaneState(createEmptyOrchestratorMissionState());
  const packet = {
    id: `pkt-3055-${name}`, referenceLabel: 'P1', title: name, summary: name,
    status: 'released', queueState: 'held', releaseState: 'released',
    releaseStatePayload: { source: 'approve_and_merge', mergeCommit: 'epoch-1-merge-sha' },
    storageAdmissionEpoch: 1, blockedReason: null, lane: null, review: null,
    dependencyPacketIds: [], dependencyLabels: [], attemptCount: 0,
    workspaceTargetPath: dataDir, branchTarget: `inline/${name}`, runtime: 'codex',
  } as OrchestratorPacket;
  const state = { ...createEmptyOrchestratorMissionState(), missionId: `mission-3055-${name}`, repoPath: dataDir, constraints: 'preserved metadata',
    packets: [packet, { ...packet, id: `sibling-${name}`, title: 'preserved sibling', status: 'archived' as const,
      archivedAt: '2026-10-01T18:00:00.000Z' }] };
  recordMission({ id: state.missionId, repoPath: dataDir, runtime: 'codex', prompt: name, summary: name,
    constraints: 'preserved metadata', packetMeta: state.packets.map(({ id, title, referenceLabel }) => ({ id, title, referenceLabel })),
    missionState: state, totalWaves: 1 });
  return structuredClone(readMissionRegistryEntry(state.missionId, { includeArchived: true })!.mission);
}

function expectReleased(packet: unknown) {
  expect(packet).toMatchObject({ status: 'released', releaseState: 'released',
    queueState: 'held', blockedReason: null });
}

describe('#3055 durable terminal release through real entry points', () => {
  it('merge persists the owning packet before cleanup and survives reopening and delayed mirrors', async () => {
    const { packetId, state, lane } = await fixture('merge');
    await withMissionRegistryState(state.missionId!, (fresh) => {
      fresh.constraints = 'durable owner metadata';
      fresh.packets.push({ ...fresh.packets[0], id: 'pkt-3055-sibling', status: 'archived',
        archivedAt: '2026-10-01T18:00:00.000Z', lane: null, title: 'durable sibling' });
      return { state: fresh, result: null };
    });
    const stale = structuredClone(readMissionRegistryEntry(state.missionId!)!.mission);
    let serviceCleanupCalls = 0;
    cleanupBoundary.check = (laneId) => {
      if (laneId !== lane.id) return;
      serviceCleanupCalls += 1;
      expectReleased(readMissionRegistryEntry(state.missionId!, { includeArchived: true })?.mission.packets[0]);
    };
    const result = await approveAndMergePacket({ packetId }).finally(() => { cleanupBoundary.check = null; });
    expect(serviceCleanupCalls).toBeGreaterThan(0);
    expect(result.merged).toBe(true);
    expect(getLane(lane.id)?.outcome).toBe('merged');
    expectReleased(readMissionRegistryEntry(state.missionId!, { includeArchived: true })?.mission.packets[0]);
    expect(readMissionRegistryEntry(state.missionId!, { includeArchived: true })?.mission.packets[1])
      .toMatchObject({ id: 'pkt-3055-sibling', title: 'durable sibling' });
    // Two queued whole-mission mirrors captured before release must not revive it.
    await Promise.all([persistMissionRegistryState(stale), persistMissionRegistryState({ ...stale, summary: 'delayed mirror' })]);
    const persisted = readMissionRegistryEntry(state.missionId!, { includeArchived: true })!;
    expectReleased(persisted.mission.packets[0]);
    expect(persisted.mission.packets[0].releaseStatePayload?.mergeCommit).toBe(result.mergeSha);
    expect(persisted.archivedAt).not.toBeNull();
    expect(persisted.mission.constraints).toBe('durable owner metadata');
    expect(persisted.mission.packets[1]).toMatchObject({ id: 'pkt-3055-sibling', title: 'durable sibling' });
  }, 90_000);

  it('ancestry persists release before archival and survives reopening', async () => {
    const { repoPath, packetId, headSha, state, lane } = await fixture('ancestry');
    git(repoPath, ['merge', '--ff-only', lane.branch]);
    git(repoPath, ['push', '-q', 'origin', 'main']);
    retirement.check = (laneId) => {
      if (laneId === lane.id) expectReleased(readMissionRegistryEntry(state.missionId!, { includeArchived: true })?.mission.packets[0]);
    };
    expect((await sweepPacketsMergedByAncestry()).merged).toBeGreaterThanOrEqual(1);
    expect(getLane(lane.id)).toMatchObject({ status: 'archived', outcome: 'merged' });
    const packet = readMissionRegistryEntry(state.missionId!, { includeArchived: true })?.mission.packets.find((p) => p.id === packetId);
    expectReleased(packet);
    expect(packet?.releaseStatePayload).toMatchObject({ source: 'merged_by_ancestry_reconcile', headSha });
    retirement.check = null;
  }, 90_000);

  it('a mirror queued behind release cannot overwrite a newer epoch with an older retry', async () => {
    const { state } = await fixture('concurrent');
    const stale = structuredClone(readMissionRegistryEntry(state.missionId!)!.mission);
    let enter!: () => void;
    let finish!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const mutation = withMissionRegistryState(state.missionId!, async (fresh) => {
      enter();
      await gate;
      const { markPacketReleased } = await import('@/lib/orchestrator/packet-release-truth');
      fresh.packets[0].storageAdmissionEpoch = 2;
      markPacketReleased(fresh.packets[0], { source: 'approve_and_merge', mergeCommit: 'fixture-sha' });
      return { state: fresh, result: null };
    });
    await entered;
    stale.packets[0].attemptCount = 3;
    const mirror = persistMissionRegistryState(stale);
    finish();
    await Promise.all([mutation, mirror]);
    expectReleased(readMissionRegistryEntry(state.missionId!, { includeArchived: true })?.mission.packets[0]);
    // A genuinely newer launch can supersede release, and explicit mutations
    // can still reset in place. The mirror guard does not force approval.
    const newer = structuredClone(stale);
    newer.packets[0].storageAdmissionEpoch = 3;
    await persistMissionRegistryState(newer);
    expect(readMissionRegistryEntry(state.missionId!, { includeArchived: true })?.mission.packets[0].releaseState).toBe('pending');
  }, 90_000);

  it('a stale released mirror cannot undo an actual durable reset to a newer epoch', async () => {
    const stale = releasedRegistryFixture('stale-after-reset');
    const reset = await resetPacket({ packetId: stale.packets[0].id, clearWorktree: true });
    expect(reset.reset).toBe(true);
    const resetPacketState = readMissionRegistryEntry(stale.missionId!, { includeArchived: true })!.mission.packets[0];
    expect(resetPacketState).toMatchObject({ status: 'draft', releaseState: 'pending', storageAdmissionEpoch: 2 });
    await persistMissionRegistryState(stale);
    const current = readMissionRegistryEntry(stale.missionId!, { includeArchived: true })!;
    expect(current.mission.packets[0]).toMatchObject({ status: 'draft', releaseState: 'pending', storageAdmissionEpoch: 2,
      releaseStatePayload: null, lane: null });
    expect(current.archivedAt).toBeNull();
    expect(current.mission.packets[1]).toMatchObject({ id: 'sibling-stale-after-reset', title: 'preserved sibling' });
    // Current-generation mirror edits still land after the reset.
    const update = structuredClone(current.mission);
    update.packets[0].completionSummary = 'current generation update';
    await persistMissionRegistryState(update);
    expect(readMissionRegistryEntry(stale.missionId!, { includeArchived: true })!.mission.packets[0].completionSummary)
      .toBe('current generation update');
  });

  it('a stale released mirror cannot replace a newer canonical release receipt', async () => {
    const stale = releasedRegistryFixture('stale-after-new-release');
    expect((await resetPacket({ packetId: stale.packets[0].id, clearWorktree: true })).reset).toBe(true);
    await withMissionRegistryState(stale.missionId!, async (fresh) => {
      const { markPacketReleased } = await import('@/lib/orchestrator/packet-release-truth');
      markPacketReleased(fresh.packets[0], { source: 'approve_and_merge', mergeCommit: 'epoch-2-merge-sha' });
      return { state: fresh, result: null };
    });
    await persistMissionRegistryState(stale);
    const current = readMissionRegistryEntry(stale.missionId!, { includeArchived: true })!;
    expectReleased(current.mission.packets[0]);
    expect(current.mission.packets[0]).toMatchObject({ storageAdmissionEpoch: 2,
      releaseStatePayload: { mergeCommit: 'epoch-2-merge-sha' } });
    expect(current.mission.packets[1]).toMatchObject({ id: 'sibling-stale-after-new-release', title: 'preserved sibling' });
    expect(current.mission.constraints).toBe('preserved metadata');
    const update = structuredClone(current.mission);
    update.packets[0].releaseStatePayload!.headSha = 'epoch-2-reviewed-head';
    await persistMissionRegistryState(update);
    expect(readMissionRegistryEntry(stale.missionId!, { includeArchived: true })!.mission.packets[0].releaseStatePayload)
      .toMatchObject({ mergeCommit: 'epoch-2-merge-sha', headSha: 'epoch-2-reviewed-head' });
  });

  it('reads both terminal missions through the durable API after SQLite reopen and file focus switch', async () => {
    closeDb();
    for (const name of ['merge', 'ancestry']) {
      const api = await durableApiRead(`mission-3055-${name}`);
      expectReleased(api.packets[0]);
    }
    const reset = await durableApiRead('mission-3055-stale-after-reset');
    expect(reset.packets[0]).toMatchObject({ releaseState: 'pending', queueState: 'held' });
    expect(readMissionRegistryEntry('mission-3055-stale-after-reset', { includeArchived: true })!.mission.packets[0])
      .toMatchObject({ status: 'draft', releaseState: 'pending', storageAdmissionEpoch: 2, releaseStatePayload: null });
    const released = await durableApiRead('mission-3055-stale-after-new-release');
    expectReleased(released.packets[0]);
    expect(readMissionRegistryEntry('mission-3055-stale-after-new-release', { includeArchived: true })!.mission.packets[0])
      .toMatchObject({ storageAdmissionEpoch: 2, releaseStatePayload: { mergeCommit: 'epoch-2-merge-sha' } });
  });

});
