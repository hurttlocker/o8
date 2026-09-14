import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorMissionState, OrchestratorPacket } from '@/lib/orchestrator/types';
import type { StorageVolumeObservation } from '@/lib/workspace/storage-admission';

const worktreeFailure = vi.hoisted(() => new Error('synthetic packet worktree provision failure'));

vi.mock('@/lib/worktree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/worktree')>();
  return {
    ...actual,
    prepareLaunchWorktree: vi.fn(async () => {
      throw worktreeFailure;
    }),
  };
});

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));

vi.mock('@/lib/analytics/server', () => ({
  emitProductEvent: vi.fn(async () => undefined),
}));

vi.mock('@/lib/workspace/manifest/terminal-release', () => ({
  settleTerminalWorkspaceManifestAndLeases: vi.fn(async () => undefined),
  settleWorkspaceManifestOnTerminal: vi.fn(),
}));

const root = mkdtempSync(join(tmpdir(), 'o8-storage-provision-failure-'));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const worktreeRoot = join(root, 'worktrees');
const priorEnv = new Map<string, string | undefined>();
const envKeys = [
  'CORTEX_IDE_DATA_DIR',
  'O8_DATA_DIR',
  'O8_WORKTREE_ROOT',
  'O8_SKIP_PRELAUNCH_TYPECHECK',
] as const;

for (const key of envKeys) priorEnv.set(key, process.env[key]);
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
process.env.O8_WORKTREE_ROOT = worktreeRoot;
process.env.O8_SKIP_PRELAUNCH_TYPECHECK = '1';

const gib = 1024 * 1024 * 1024;
const availableBytes = 20 * gib;
const estimateBytes = 8 * gib;

function packet(id: string): OrchestratorPacket {
  return {
    id,
    referenceLabel: id.toUpperCase(),
    title: `packet ${id}`,
    summary: 'exercise storage release after provision failure',
    workspaceTargetPath: repoPath,
    branchTarget: `packet/${id}`,
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

function mission(target: OrchestratorPacket): OrchestratorMissionState {
  return {
    missionId: `mission-${target.id}`,
    repoPath,
    runtime: 'codex',
    packets: [target],
    updatedAt: new Date().toISOString(),
  } as OrchestratorMissionState;
}

function observed(targetPath: string): StorageVolumeObservation {
  return {
    status: 'observed',
    targetPath,
    probePath: worktreeRoot,
    volumeId: 'device:provision-failure-test',
    availableBytes,
    freeBytes: availableBytes,
    totalBytes: 100 * gib,
    observedAt: Date.now(),
    error: null,
  };
}

beforeAll(() => {
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(worktreeRoot, { recursive: true });
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: repoPath, stdio: 'pipe' });
  writeFileSync(join(repoPath, 'README.md'), 'storage provision failure real path\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', [
    '-c', 'user.name=o8 test',
    '-c', 'user.email=o8@test.invalid',
    'commit', '-m', 'init',
  ], { cwd: repoPath, stdio: 'pipe' });
});

afterAll(async () => {
  const { closeDb } = await import('@/lib/db');
  closeDb();
  for (const [key, value] of priorEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('packet storage admission provision failure real path', () => {
  it('releases the failed owner and admits the next launch at the same free space', async () => {
    const [
      { launchPacketWithStorageAdmission },
      { resolveWorkerRouting },
      { createPacketStorageAdmissionCoordinator },
      { StorageAdmissionStore },
      controlPlane,
      laneRegistry,
      { getSqlite },
    ] = await Promise.all([
      import('@/lib/orchestrator/dispatch-packet-launch'),
      import('@/lib/agents/routing'),
      import('@/lib/orchestrator/storage-admission'),
      import('@/lib/workspace/storage-admission'),
      import('@/lib/orchestrator/control-plane'),
      import('@/lib/lane/registry'),
      import('@/lib/db'),
    ]);
    const sqlite = getSqlite();
    const store = new StorageAdmissionStore(sqlite, {
      now: Date.now,
      observeVolume: async (targetPath) => observed(targetPath),
    });
    const storageAdmission = createPacketStorageAdmissionCoordinator({
      sqlite,
      store,
      now: Date.now,
      observeEstimate: async () => ({
        status: 'observed',
        exactBytes: estimateBytes,
        source: 'source-size-fallback',
        historySamples: 0,
        workspacePaths: [],
        error: null,
      }),
      resolveReservationTarget: () => worktreeRoot,
      observeRootIdentity: async () => ({
        canonicalPath: worktreeRoot,
        device: 'provision-failure-test',
        inode: '1',
      }),
      observeReservationVolume: async (targetPath) => observed(targetPath),
      resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 10 * gib }),
    });

    const launchAndReadFailure = async (packetId: string) => {
      const candidate = packet(packetId);
      controlPlane.writeOrchestratorControlPlaneState(mission(candidate));
      await expect(launchPacketWithStorageAdmission({
        packet: candidate,
        allPackets: [candidate],
        workerRouting: resolveWorkerRouting({
          requestedRuntime: 'codex',
          source: 'scheduler-dispatch',
        }),
        storageAdmission,
      })).rejects.toMatchObject({
        message: expect.stringContaining('packet_worktree_provision_failed'),
      });
      const lane = laneRegistry.findLatestLaneByPacket(packetId)!;
      const event = laneRegistry.getLaneEvents(lane.id, 200)
        .find((candidateEvent) => candidateEvent.verb === 'worktree_provision_failed');
      const reservation = sqlite.prepare(`
        SELECT reservation_id, state, last_reason, last_mutation_id
        FROM storage_admission_reservations
        WHERE owner_id = ?
        ORDER BY owner_generation DESC
        LIMIT 1
      `).get(packetId) as {
        reservation_id: string;
        state: string;
        last_reason: string;
        last_mutation_id: string;
      };
      return { event, lane, reservation };
    };

    const first = await launchAndReadFailure('pkt-storage-provision-failure-one');
    expect(first.lane).toMatchObject({ status: 'failed', worktreePath: null });
    expect(first.reservation).toMatchObject({ state: 'released', last_reason: 'released' });
    expect(sqlite.prepare(`
      SELECT COUNT(*)
      FROM storage_admission_reservations
      WHERE owner_id = ? AND state = 'reserved'
    `).pluck().get('pkt-storage-provision-failure-one')).toBe(0);
    expect(sqlite.prepare(`
      SELECT operation
      FROM storage_admission_mutations
      WHERE mutation_id = ? AND reservation_id = ?
    `).pluck().get(first.reservation.last_mutation_id, first.reservation.reservation_id)).toBe('release');
    expect(first.event?.payload).toMatchObject({
      storageRelease: {
        decision: 'released',
        ownerGeneration: 1,
        releasedReservations: 1,
        retainedOwnerIds: [],
      },
    });

    const second = await launchAndReadFailure('pkt-storage-provision-failure-two');
    expect(second.lane).toMatchObject({ status: 'failed', worktreePath: null });
    expect(second.reservation).toMatchObject({ state: 'released', last_reason: 'released' });
    expect(second.event).toBeDefined();
  }, 30_000);

  it('records an unprovable release scope on the provision failure event', async () => {
    const [{ getSqlite }, laneRegistry, { StorageAdmissionStore }, { packetWorktreeProvisionError }] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/lane/registry'),
      import('@/lib/workspace/storage-admission'),
      import('@/lib/runtime/packet-worktree-guard'),
    ]);
    const packetId = 'pkt-storage-provision-unprovable';
    const lane = laneRegistry.createLane({
      repoPath,
      branch: `packet/${packetId}`,
      runtime: 'codex',
      packetId,
    });
    laneRegistry.setLaneStatus(lane.id, 'launching', 'orchestrator', 'launching_session');
    const store = new StorageAdmissionStore(getSqlite(), {
      now: Date.now,
      observeVolume: async (targetPath) => observed(targetPath),
    });
    await store.reserve({
      mutationId: `reserve-${packetId}`,
      reservationId: `packet-storage:${packetId}:1`,
      targetPath: worktreeRoot,
      exactBytes: estimateBytes,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: Date.now() + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 10 * gib },
    });

    packetWorktreeProvisionError(
      { existingLaneId: lane.id, packetId, isolate: true },
      'codex',
      repoPath,
      worktreeFailure,
      worktreeFailure.message,
    );

    expect(laneRegistry.getLane(lane.id)?.status).toBe('awaiting_input');
    expect(store.getReservation(`packet-storage:${packetId}:1`)).toMatchObject({ state: 'reserved' });
    expect(laneRegistry.getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'worktree_provision_failed',
        payload: expect.objectContaining({
          storageRelease: expect.objectContaining({
            decision: 'deferred',
            ownerGeneration: null,
            releasedBytes: 0,
            releasedReservations: 0,
            retainedOwnerIds: [packetId],
            reason: 'release_scope_unprovable',
          }),
        }),
      }),
    ]));
  });

  it('retains storage when a packet-named checkout exists before lane binding', async () => {
    const [
      { getSqlite },
      laneRegistry,
      { recordLaneEvent },
      { StorageAdmissionStore },
      { packetWorktreeProvisionError },
      { managedPacketWorktreeId },
    ] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/lane/registry'),
      import('@/lib/lane/events'),
      import('@/lib/workspace/storage-admission'),
      import('@/lib/runtime/packet-worktree-guard'),
      import('@/lib/worktree/root-layout'),
    ]);
    const packetId = 'pkt-storage-provision-materialized';
    const reservationId = `packet-storage:${packetId}:1`;
    const materializedRoot = join(root, 'materialized-worktrees');
    mkdirSync(materializedRoot, { recursive: true });
    const lane = laneRegistry.createLane({
      repoPath,
      branch: `packet/${packetId}`,
      runtime: 'codex',
      packetId,
    });
    laneRegistry.setLaneStatus(lane.id, 'launching', 'orchestrator', 'launching_session');
    const store = new StorageAdmissionStore(getSqlite(), {
      now: Date.now,
      observeVolume: async (targetPath) => ({
        ...observed(targetPath),
        volumeId: 'device:materialized-provision-test',
      }),
    });
    await store.reserve({
      mutationId: `reserve-${packetId}`,
      reservationId,
      targetPath: materializedRoot,
      exactBytes: estimateBytes,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: Date.now() + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 10 * gib },
    });
    recordLaneEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: reservationId,
    });
    mkdirSync(join(materializedRoot, managedPacketWorktreeId(packetId)!), { recursive: true });

    packetWorktreeProvisionError(
      { existingLaneId: lane.id, packetId, isolate: true },
      'codex',
      repoPath,
      worktreeFailure,
      worktreeFailure.message,
    );

    expect(laneRegistry.getLane(lane.id)?.status).toBe('awaiting_input');
    expect(store.getReservation(reservationId)).toMatchObject({ state: 'reserved' });
    expect(laneRegistry.getLaneEvents(lane.id, 200)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        verb: 'worktree_provision_failed',
        payload: expect.objectContaining({
          storageRelease: expect.objectContaining({
            decision: 'deferred',
            reason: 'materialized_worktree_present',
          }),
        }),
      }),
    ]));
  });
});
