import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const launchCalls = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/runtime/actions', () => ({
  launchRuntimeSurface: vi.fn(async (input: { packetId?: string; repoPath: string }) => {
    launchCalls.push(input.packetId ?? 'unknown');
    return {
      ok: true,
      surfaceId: `codex-owned:${input.packetId}`,
      note: 'mock launch',
      worktree: { path: input.repoPath },
    };
  }),
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

const testRoot = mkdtempSync(join(tmpdir(), 'o8-storage-admission-real-path-'));
const repoPath = join(testRoot, 'repo');
const worktreeRoot = join(testRoot, 'managed-worktrees');
process.env.O8_WORKTREE_ROOT = worktreeRoot;

const { getSqlite } = await import('@/lib/db');
const {
  readOrchestratorControlPlaneState,
  writeOrchestratorControlPlaneState,
} = await import('@/lib/orchestrator/control-plane');
const { createEmptyOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const { runDispatchTick } = await import('@/lib/orchestrator/scheduling');
const {
  createPacketStorageAdmissionCoordinator,
  observeRepoStorageEstimate,
} = await import('@/lib/orchestrator/storage-admission');
const { createStoragePressureAdmissionCoordinator } = await import(
  '@/lib/orchestrator/storage-pressure-policy'
);
const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');
const statusRoute = await import('@/app/api/orchestrator/status/route');
import type { Lane } from '@/lib/lane/types';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { RepoRegistryEntry } from '@/lib/repos/types';

beforeAll(() => {
  mkdirSync(repoPath);
  mkdirSync(worktreeRoot);
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), 'storage admission real path\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['-c', 'user.email=test@o8.local', '-c', 'user.name=o8-test', 'commit', '-m', 'init'], {
    cwd: repoPath,
  });
});

afterEach(() => {
  vi.useRealTimers();
  launchCalls.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete process.env.O8_WORKTREE_ROOT;
  rmSync(testRoot, { recursive: true, force: true });
});

function packet(id = 'packet-storage-retry'): OrchestratorPacket {
  return {
    id,
    referenceLabel: 'PKT-STORAGE-RETRY',
    title: 'storage retry',
    summary: 'storage retry',
    workspaceTargetPath: repoPath,
    branchTarget: 'issue/storage-retry-real-path',
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'queued',
    releaseState: 'pending',
    status: 'queued',
    blockedReason: null,
    lane: null,
  };
}

const POLICY_SENTENCE = 'Storage policy keeps 10% of disk or 10.0 GB, whichever is greater, unallocated.';

function reviewingLane(): Lane {
  return {
    id: 'lane-storage-review',
    projectId: null,
    label: 'storage review candidate',
    repoPath,
    worktreePath: repoPath,
    branch: 'inline/storage-review-candidate',
    baseBranch: 'main',
    runtime: 'codex',
    sessionKey: 'owned:storage-review-candidate',
    packetId: 'packet-storage-review-candidate',
    prNumber: null,
    status: 'reviewing',
    ownership: 'managed',
    writerToken: null,
    lastHeartbeatAt: null,
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    lastEventAt: '2026-08-20T12:00:00.000Z',
    lastEventLabel: 'review_ready',
  };
}

function reviewRepo(): RepoRegistryEntry {
  return {
    id: 'repo-storage-review',
    name: 'storage review repo',
    localPath: repoPath,
    remoteUrl: null,
    defaultBranch: 'main',
    addedAt: '2026-08-20T12:00:00.000Z',
    lastOpenedAt: null,
    storagePressureParkingDisabled: false,
    setup: {
      envMode: 'copy',
      envFiles: [],
      installCommand: null,
      installOnCreateWorkspace: false,
      buildCommand: null,
      runBuildOnCreateWorkspace: false,
      devCommand: null,
      defaultPort: null,
      workspaceIsolationPreference: 'auto',
    },
  };
}

async function readStatusPacket(missionId: string): Promise<OrchestratorPacket> {
  const response = await statusRoute.GET(new NextRequest(
    `http://127.0.0.1/api/orchestrator/status?missionId=${missionId}`,
    { headers: { Host: '127.0.0.1' } },
  ));
  const body = await response.json() as { result: { packets: OrchestratorPacket[] } };
  return body.result.packets[0]!;
}

describe('storage admission dispatch real path', () => {
  it('uses timeout fallback, surfaces a capacity hold, and retries it from persisted state', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
    vi.stubEnv('O8_WORKSPACE_PARKING_MODE', 'manual');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    let availableBytes = 12 * 1024 * 1024 * 1024;
    let refreshCalls = 0;
    const observeVolume = async (targetPath: string) => ({
      status: 'observed' as const,
      targetPath,
      probePath: worktreeRoot,
      volumeId: 'device:test',
      availableBytes,
      freeBytes: availableBytes,
      totalBytes: 100 * 1024 * 1024 * 1024,
      observedAt: Date.now(),
      error: null,
    });
    const store = new StorageAdmissionStore(getSqlite(), { now: Date.now, observeVolume });
    const admission = createPacketStorageAdmissionCoordinator({
      sqlite: getSqlite(),
      store,
      now: Date.now,
      observeEstimate: (targetPath) => observeRepoStorageEstimate(targetPath, {
        readCachedMeasurement: () => null,
        refreshMeasurement: async () => {
          refreshCalls += 1;
          throw Object.assign(new Error('du timed out'), { code: 'ETIMEDOUT' });
        },
        defer: (task) => task(),
      }),
      observeReservationVolume: observeVolume,
      resolvePolicy: () => ({
        reserveRatio: 0.1,
        absoluteFloorBytes: 10 * 1024 * 1024 * 1024,
      }),
    });
    const park = vi.fn();
    const pressureAdmission = createStoragePressureAdmissionCoordinator(admission, {
      listLanes: () => [reviewingLane()],
      listRepos: async () => [reviewRepo()],
      measureAllocatedBytes: async () => 4 * 1024 * 1024 * 1024,
      observeVolume,
      getSnapshot: () => null,
      parkWorkspace: park,
    });
    const initial = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-storage-retry',
      repoPath,
      runtime: 'codex' as const,
      packets: [packet()],
    };

    const held = await runDispatchTick(initial, {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: pressureAdmission,
    });
    expect(refreshCalls).toBeGreaterThan(0);
    expect(launchCalls).toEqual([]);
    expect(held.packets[0]).toMatchObject({
      status: 'queued',
      blockedReason: expect.stringContaining('reserve_breached'),
      lastEventLabel: 'storage_admission_held',
      storageAdmission: {
        state: 'held',
        reason: 'reserve_breached',
        estimateBytes: 8 * 1024 * 1024 * 1024,
        pressure: {
          mode: 'manual',
          status: 'manual_review',
          candidates: [{
            packetId: 'packet-storage-review-candidate',
            measuredAllocatedBytes: 4 * 1024 * 1024 * 1024,
            outcome: 'candidate',
            reason: 'manual_action_required',
          }],
        },
      },
    });
    expect(held.packets[0]?.blockedReason).toContain(
      'Storage policy keeps 10% of disk or 10.0 GB, whichever is greater, unallocated.',
    );
    expect(held.packets[0]?.blockedReason).toContain(
      "Free 6.0 GB more to dispatch this packet's 8.0 GB estimate",
    );
    expect(park).not.toHaveBeenCalled();
    writeOrchestratorControlPlaneState(held);

    const response = await statusRoute.GET(new NextRequest(
      'http://127.0.0.1/api/orchestrator/status?missionId=mission-storage-retry',
      { headers: { Host: '127.0.0.1' } },
    ));
    const body = await response.json() as {
      result: { packets: Array<Pick<OrchestratorPacket, 'status' | 'blockedReason' | 'storageAdmission'>> };
    };
    expect(body.result.packets[0]).toMatchObject({
      status: 'queued',
      blockedReason: expect.stringContaining('reserve_breached'),
      storageAdmission: {
        state: 'held',
        reason: 'reserve_breached',
        pressure: {
          mode: 'manual',
          status: 'manual_review',
          candidates: [{ outcome: 'candidate' }],
        },
      },
    });

    const duringBackoff = await runDispatchTick(readOrchestratorControlPlaneState(), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: pressureAdmission,
    });
    expect(duringBackoff.packets[0]?.status).toBe('queued');
    expect(launchCalls).toEqual([]);

    availableBytes = 51 * 1024 * 1024 * 1024;
    vi.advanceTimersByTime(10_001);
    const retried = await runDispatchTick(duringBackoff, {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: pressureAdmission,
    });
    expect(retried.packets[0]).toMatchObject({
      status: 'launching',
      blockedReason: null,
      storageAdmission: { state: 'committed', estimateBytes: 8 * 1024 * 1024 * 1024 },
    });
    expect(launchCalls).toEqual(['packet-storage-retry']);
  }, 30_000);

  it('names reclaim candidates in the hold message on the first hold and on the replayed hold', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'));
    vi.stubEnv('O8_WORKSPACE_PARKING_MODE', 'manual');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const availableBytes = 12 * 1024 * 1024 * 1024;
    const observeVolume = async (targetPath: string) => ({
      status: 'observed' as const,
      targetPath,
      probePath: worktreeRoot,
      volumeId: 'device:test',
      availableBytes,
      freeBytes: availableBytes,
      totalBytes: 100 * 1024 * 1024 * 1024,
      observedAt: Date.now(),
      error: null,
    });
    const store = new StorageAdmissionStore(getSqlite(), { now: Date.now, observeVolume });
    const admission = createPacketStorageAdmissionCoordinator({
      sqlite: getSqlite(),
      store,
      now: Date.now,
      observeEstimate: (targetPath) => observeRepoStorageEstimate(targetPath, {
        readCachedMeasurement: () => null,
        refreshMeasurement: async () => {
          throw Object.assign(new Error('du timed out'), { code: 'ETIMEDOUT' });
        },
        defer: (task) => task(),
      }),
      observeReservationVolume: observeVolume,
      resolvePolicy: () => ({
        reserveRatio: 0.1,
        absoluteFloorBytes: 10 * 1024 * 1024 * 1024,
      }),
    });
    const pressureAdmission = createStoragePressureAdmissionCoordinator(admission, {
      listLanes: () => [reviewingLane()],
      listRepos: async () => [reviewRepo()],
      measureAllocatedBytes: async () => 4 * 1024 * 1024 * 1024,
      observeVolume,
      getSnapshot: () => null,
      parkWorkspace: vi.fn(),
    });
    const initial = {
      ...createEmptyOrchestratorMissionState(),
      missionId: 'mission-storage-candidates',
      repoPath,
      runtime: 'codex' as const,
      packets: [packet('packet-storage-candidates')],
    };

    const held = await runDispatchTick(initial, {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: pressureAdmission,
    });
    expect(launchCalls).toEqual([]);
    expect(held.packets[0]?.storageAdmission?.pressure?.candidates[0]).toMatchObject({
      outcome: 'candidate',
      workspacePath: repoPath,
      measuredAllocatedBytes: 4 * 1024 * 1024 * 1024,
    });
    writeOrchestratorControlPlaneState(held);

    const firstStatus = await readStatusPacket('mission-storage-candidates');
    expect(firstStatus.blockedReason).toContain(POLICY_SENTENCE);
    expect(firstStatus.blockedReason).toContain(`Reclaim candidates, largest first: ${repoPath} (4.0 GB).`);
    expect(firstStatus.storageAdmission?.pressure?.candidates[0]?.workspacePath).toBe(repoPath);

    // Drop the receipt the way a control-plane row written before the hold
    // persisted would: the next tick recomputes the same launch generation and
    // replays the recorded reserve mutation instead of taking a fresh one.
    writeOrchestratorControlPlaneState({
      ...held,
      packets: [{ ...held.packets[0]!, storageAdmission: null }],
    });
    const replayed = await runDispatchTick(readOrchestratorControlPlaneState(), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: pressureAdmission,
    });
    expect(launchCalls).toEqual([]);
    expect(replayed.packets[0]?.storageAdmission).toMatchObject({
      state: 'held',
      reason: 'reserve_breached',
      mutationId: 'packet-storage-reserve:packet-storage-candidates:1',
    });
    writeOrchestratorControlPlaneState(replayed);

    const replayStatus = await readStatusPacket('mission-storage-candidates');
    expect(replayStatus.blockedReason).toContain(POLICY_SENTENCE);
    expect(replayStatus.blockedReason).toContain(`Reclaim candidates, largest first: ${repoPath} (4.0 GB).`);
    expect(replayStatus.storageAdmission?.pressure?.candidates[0]?.workspacePath).toBe(repoPath);
  }, 30_000);
});
