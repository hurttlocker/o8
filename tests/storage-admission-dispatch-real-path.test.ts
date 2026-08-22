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
const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');
const statusRoute = await import('@/app/api/orchestrator/status/route');
import type { OrchestratorPacket } from '@/lib/orchestrator/types';

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
  vi.unstubAllGlobals();
});

afterAll(() => {
  delete process.env.O8_WORKTREE_ROOT;
  rmSync(testRoot, { recursive: true, force: true });
});

function packet(): OrchestratorPacket {
  return {
    id: 'packet-storage-retry',
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

describe('storage admission dispatch real path', () => {
  it('uses timeout fallback, surfaces a capacity hold, and retries it from persisted state', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
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
      resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 1024 * 1024 * 1024 }),
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
      storageAdmission: admission,
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
      },
    });
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
      storageAdmission: { state: 'held', reason: 'reserve_breached' },
    });

    const duringBackoff = await runDispatchTick(readOrchestratorControlPlaneState(), {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: admission,
    });
    expect(duringBackoff.packets[0]?.status).toBe('queued');
    expect(launchCalls).toEqual([]);

    availableBytes = 51 * 1024 * 1024 * 1024;
    vi.advanceTimersByTime(10_001);
    const retried = await runDispatchTick(duringBackoff, {
      launchBudget: { maxLaunches: 1 },
      storageAdmission: admission,
    });
    expect(retried.packets[0]).toMatchObject({
      status: 'launching',
      blockedReason: null,
      storageAdmission: { state: 'committed', estimateBytes: 8 * 1024 * 1024 * 1024 },
    });
    expect(launchCalls).toEqual(['packet-storage-retry']);
  }, 30_000);
});
