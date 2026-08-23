import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import type { StorageVolumeObservation } from '@/lib/workspace/storage-admission';

vi.mock('@/lib/lane/reap-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/reap-sessions')>();
  return {
    ...actual,
    archiveLaneSessionsConfirmed: vi.fn(async () => ({
      targeted: 0, archived: 0, outcomes: [], failures: [],
    })),
    killLaneSessionsConfirmed: vi.fn(async () => []),
  };
});

vi.mock('@/lib/lane/durable-review-approval', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/lane/durable-review-approval')>();
  return {
    ...actual,
    supersedeDurableApprovedReviews: vi.fn(async (...args: Parameters<typeof actual.supersedeDurableApprovedReviews>) => {
      if (args[1].includes('rerun_with_feedback')) {
        throw new Error('stop after prior generation retirement');
      }
      return actual.supersedeDurableApprovedReviews(...args);
    }),
  };
});

const dataDir = mkdtempSync(join(tmpdir(), 'o8-storage-rerun-release-'));
const repoPath = mkdtempSync(join(tmpdir(), 'o8-storage-rerun-repo-'));
const worktreeRoot = mkdtempSync(join(tmpdir(), 'o8-storage-cleanup-worktrees-'));
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
execFileSync('git', ['-c', 'user.email=test@o8.local', '-c', 'user.name=o8-test',
  'commit', '--allow-empty', '-q', '-m', 'base'], { cwd: repoPath });
const operatorToken = 'operator-storage-rerun-release-0123456789abcdef';
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const rerunRoute = await import('@/app/api/orchestrator/rerun-with-feedback/route');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { appendEvent, createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { createMission } = await import('@/lib/orchestrator/operator-mission-service');
const { withLockedState } = await import('@/lib/orchestrator/control-plane');
const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
  rmSync(worktreeRoot, { recursive: true, force: true });
});

function createWorktree(label: string): { branch: string; worktreePath: string } {
  const branch = `inline/${label}`;
  const worktreePath = join(worktreeRoot, label);
  execFileSync('git', ['worktree', 'add', '-q', '-b', branch, worktreePath, 'main'], { cwd: repoPath });
  return { branch, worktreePath };
}

async function createRunningPacket(label: string, withWorktree = true, absentWorktree = false) {
  const mission = await createMission({
    issues: [{ number: Date.now(), title: `inline: ${label}`, body: label, url: '' }],
    repoPath,
    runtime: 'codex',
    constraints: '',
  });
  const packetId = mission.packets[0]!.id;
  const branch = `inline/${label}`;
  const worktreePath = withWorktree
    ? absentWorktree ? join(worktreeRoot, `absent-${label}`) : createWorktree(label).worktreePath
    : null;
  const lane = createLane({ repoPath, branch, worktreePath: worktreePath ?? undefined, runtime: 'codex', packetId });
  appendEvent(lane.id, 'update', 'orchestrator', {
    storageAdmissionOwnerGeneration: 1,
    storageAdmissionReservationId: `packet-storage:${packetId}:1`,
  });
  setLaneStatus(lane.id, 'running', 'system', 'test_running');
  await withLockedState((state) => {
    const packet = state.packets.find((candidate) => candidate.id === packetId)!;
    packet.status = 'running';
    packet.queueState = 'queued';
    packet.branchTarget = branch;
    packet.lane = {
      tileId: `tile-${label}`, tabId: `tab-${label}`, repoPath,
      worktreePath, runtime: 'codex', laneId: lane.id, sessionKey: null,
      lastHeartbeatAt: null, lastEventAt: null, lastEventLabel: null,
    };
  });
  return { packetId, lane, worktreePath };
}

async function reserveForOwner(ownerId: string) {
  const now = Date.now();
  const observation: StorageVolumeObservation = {
    status: 'observed', targetPath: repoPath, probePath: repoPath,
    volumeId: 'device:reset-rerun-release', availableBytes: 10_000,
    freeBytes: 10_000, totalBytes: 20_000, observedAt: now, error: null,
  };
  const store = new StorageAdmissionStore(getSqlite(), {
    now: () => now,
    observeVolume: async () => observation,
  });
  const reservationId = `packet-storage:${ownerId}:1`;
  await store.reserve({
    mutationId: `reserve-${ownerId}`, reservationId, targetPath: repoPath,
    exactBytes: 2_000, ownerId, ownerGeneration: 1,
    leaseExpiresAt: now + 60_000,
    policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
  });
  return { reservationId, store };
}

describe('storage reservation release through rerun retirement', () => {
  it('releases only the retired generation while a newer packet lane remains live', async () => {
    const packetId = 'generation-scoped-release';
    const oldLane = createLane({
      repoPath, branch: 'inline/generation-old', runtime: 'codex', packetId,
    });
    const newerLane = createLane({
      repoPath, branch: 'inline/generation-new', runtime: 'codex', packetId,
    });
    appendEvent(oldLane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: 'packet-storage:generation-scoped-release:1',
    });
    appendEvent(newerLane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 2,
      storageAdmissionReservationId: 'packet-storage:generation-scoped-release:2',
    });
    setLaneStatus(oldLane.id, 'running', 'system', 'old_generation_running');
    setLaneStatus(newerLane.id, 'running', 'system', 'new_generation_running');
    const now = Date.now();
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async () => ({
        status: 'observed', targetPath: repoPath, probePath: repoPath,
        volumeId: 'device:generation-release', availableBytes: 10_000,
        freeBytes: 10_000, totalBytes: 20_000, observedAt: now, error: null,
      }),
    });
    await store.reserve({
      mutationId: 'reserve-generation-1',
      reservationId: 'packet-storage:generation-scoped-release:1',
      targetPath: repoPath, exactBytes: 2_000, ownerId: packetId,
      ownerGeneration: 1, leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    await store.reserve({
      mutationId: 'reserve-generation-2',
      reservationId: 'packet-storage:generation-scoped-release:2',
      targetPath: repoPath, exactBytes: 2_000, ownerId: packetId,
      ownerGeneration: 2, leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });

    setLaneStatus(oldLane.id, 'completed', 'system', 'old_generation_retired');

    expect(store.getReservation('packet-storage:generation-scoped-release:1')?.state).toBe('released');
    expect(store.getReservation('packet-storage:generation-scoped-release:2')?.state).toBe('reserved');
    expect(getLane(newerLane.id)?.status).toBe('running');
  });

  it('releases a lane-owned reservation after rerun clears packetId with no worktree', async () => {
    const { packetId, lane } = await createRunningPacket('rerun-cleared-packet', false);
    const { reservationId, store } = await reserveForOwner(lane.id);

    const response = await rerunRoute.POST(new NextRequest(
      'http://localhost:3001/api/orchestrator/rerun-with-feedback',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001', authorization: `Bearer ${operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          packetId, feedback: 'retry after clearing the packet binding',
          idempotencyKey: 'storage-rerun-cleared-packet',
        }),
      },
    ));

    expect(response.status).toBe(409);
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived', packetId: '', outcome: 'discarded',
      outcomeNote: 'Superseded by rerun',
    });
    expect(store.getReservation(reservationId)?.state).toBe('released');
  });

  it('releases a packet-owned reservation through rerun worktree cleanup without terminal true', async () => {
    const { packetId, lane, worktreePath } = await createRunningPacket('rerun-release');
    const { reservationId, store } = await reserveForOwner(packetId);

    const response = await rerunRoute.POST(new NextRequest(
      'http://localhost:3001/api/orchestrator/rerun-with-feedback',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001', authorization: `Bearer ${operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          packetId, feedback: 'retry through the persisted route',
          idempotencyKey: 'storage-rerun-release',
        }),
      },
    ));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: 'rerun_failed' },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived', packetId: '', outcome: 'discarded',
      outcomeNote: 'Superseded by rerun',
    });
    expect(() => execFileSync('test', ['-e', worktreePath!])).toThrow();
    expect(store.getReservation(reservationId)?.state).toBe('released');
  });

  it('releases a packet-owned reservation through reset worktree cleanup without terminal true', async () => {
    const { packetId, lane, worktreePath } = await createRunningPacket('reset-release');
    const { reservationId, store } = await reserveForOwner(packetId);

    const response = await resetRoute.POST(new NextRequest(
      'http://localhost:3001/api/orchestrator/reset-packet',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001', authorization: `Bearer ${operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          packetId, clearWorktree: true,
          idempotencyKey: 'storage-reset-release',
        }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { reset: true, worktreePruned: true },
    });
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived', packetId: '', outcome: 'discarded',
      outcomeNote: 'Superseded by reset',
    });
    expect(() => execFileSync('test', ['-e', worktreePath!])).toThrow();
    expect(store.getReservation(reservationId)?.state).toBe('released');
  });

  it('releases a packet-owned reservation when reset finds the worktree already absent', async () => {
    const { packetId, lane, worktreePath } = await createRunningPacket('reset-absent-release', true, true);
    const { reservationId, store } = await reserveForOwner(packetId);

    const response = await resetRoute.POST(new NextRequest(
      'http://localhost:3001/api/orchestrator/reset-packet',
      {
        method: 'POST',
        headers: {
          host: 'localhost:3001', authorization: `Bearer ${operatorToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          packetId, clearWorktree: true,
          idempotencyKey: 'storage-reset-absent-release',
        }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      result: { reset: true, worktreePruned: true },
    });
    expect(worktreePath).not.toBeNull();
    expect(getLane(lane.id)).toMatchObject({
      status: 'archived', packetId: '', outcome: 'discarded',
      outcomeNote: 'Superseded by reset',
    });
    expect(store.getReservation(reservationId)?.state).toBe('released');
  });
});
