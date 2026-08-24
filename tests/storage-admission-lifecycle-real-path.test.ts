import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import type { StorageVolumeObservation } from '@/lib/workspace/storage-admission';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-storage-lifecycle-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, deleteLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { cleanupAndDeleteLane } = await import('@/lib/lane/cleanup-and-delete');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { sweepTerminalCortexWorktrees } = await import('@/lib/lane/terminal-worktree-sweep');
const {
  createPacketStorageAdmissionCoordinator,
  reconcileExpiredPacketStorageReservations,
  resolveDurablePacketStorageOwner,
} = await import('@/lib/orchestrator/storage-admission');
const {
  StorageAdmissionStore,
} = await import('@/lib/workspace/storage-admission');
const { settlePacketStorageBeforeRemoval } = await import('@/lib/orchestrator/packet-storage-removal');
const {
  readOrchestratorControlPlaneState,
  withLockedState,
} = await import('@/lib/orchestrator/control-plane');
const { pruneTask } = await import('@/lib/tasks/actions');

const roots: string[] = [dataDir];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo(packetId: string) {
  const repoPath = mkdtempSync(join(tmpdir(), `o8-storage-lifecycle-${packetId}-`));
  roots.push(repoPath);
  git(repoPath, ['init', '-q', '-b', 'main']);
  git(repoPath, ['config', 'user.email', 'test@o8.local']);
  git(repoPath, ['config', 'user.name', 'o8 test']);
  writeFileSync(join(repoPath, 'base.txt'), 'base\n');
  git(repoPath, ['add', 'base.txt']);
  git(repoPath, ['commit', '-q', '-m', 'base']);
  const branch = `inline/${packetId}`;
  const worktreePath = join(repoPath, '.cortex-worktrees', `packet-${packetId}`);
  git(repoPath, ['worktree', 'add', '-q', '-b', branch, worktreePath, 'main']);
  return { repoPath, branch, worktreePath };
}

function observed(targetPath: string, observedAt: number): StorageVolumeObservation {
  return {
    status: 'observed',
    targetPath,
    probePath: targetPath,
    volumeId: 'device:lifecycle-test',
    availableBytes: 10_000,
    freeBytes: 10_000,
    totalBytes: 20_000,
    observedAt,
    error: null,
  };
}

function terminalPacketWithAdmission(input: {
  packetId: string;
  reservationId: string;
  repoPath: string;
  worktreePath?: string | null;
}): OrchestratorPacket {
  const recordedAt = Date.now();
  return {
    id: input.packetId,
    referenceLabel: input.packetId,
    title: input.packetId,
    summary: input.packetId,
    workspaceTargetPath: input.repoPath,
    branchTarget: `inline/${input.packetId}`,
    runtime: 'codex',
    dependencyLabels: [],
    dependencyPacketIds: [],
    queueState: 'held',
    releaseState: 'released',
    status: 'released',
    storageAdmission: {
      schema: 'o8/packet-storage-admission/v1',
      state: 'reserved',
      reason: 'reserved',
      reservationId: input.reservationId,
      mutationId: `reserve-${input.packetId}`,
      ownerId: input.packetId,
      ownerGeneration: 1,
      estimateBytes: 2_000,
      estimateSource: 'source-size-fallback',
      historySamples: 0,
      volumeId: 'device:lifecycle-test',
      physicalAvailableBytes: 10_000,
      reservedBeforeBytes: 0,
      requiredReserveBytes: 1_000,
      dispatchHeadroomBytes: 9_000,
      recordedAt,
    },
    lane: input.worktreePath === undefined ? null : {
      tileId: 'test-tile',
      tabId: 'test-tab',
      repoPath: input.repoPath,
      worktreePath: input.worktreePath,
      runtime: 'codex',
    },
  };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for terminal cleanup.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterAll(() => {
  closeDb();
  for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
});

describe('storage reservation lifecycle real paths', () => {
  it('drops reservedBeforeBytes after a lane reaches completed through the registry cleanup path', async () => {
    const packetId = 'terminal-release';
    const { repoPath, branch, worktreePath } = makeRepo(packetId);
    const now = Date.now();
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async (targetPath) => observed(targetPath, now),
    });
    await store.reserve({
      mutationId: 'reserve-terminal-release',
      reservationId: 'packet-storage:terminal-release:1',
      targetPath: repoPath,
      exactBytes: 2_000,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    const lane = createLane({
      repoPath,
      branch,
      runtime: 'codex',
      packetId,
      worktreePath,
    });
    recordLaneEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: 'packet-storage:terminal-release:1',
    });

    setLaneStatus(lane.id, 'completed', 'system', 'merged');
    await sweepTerminalCortexWorktrees(repoPath);
    await waitFor(() => !existsSync(worktreePath));
    await waitFor(() => store.getReservation('packet-storage:terminal-release:1')?.state === 'released');

    const next = await store.reserve({
      mutationId: 'reserve-after-terminal-release',
      reservationId: 'packet-storage:after-terminal-release:1',
      targetPath: repoPath,
      exactBytes: 1_000,
      ownerId: 'after-terminal-release',
      ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    expect(next.activeReservedBytes).toBe(0);
  });

  it('carries the exact owner generation through lane deletion until removal completes', async () => {
    const packetId = 'delete-after-removal';
    const { repoPath, branch, worktreePath } = makeRepo(packetId);
    const now = Date.now();
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async (targetPath) => observed(targetPath, now),
    });
    for (const generation of [1, 2]) {
      const reservationId = `packet-storage:${packetId}:${generation}`;
      await store.reserve({
        mutationId: `reserve-${packetId}-${generation}`,
        reservationId,
        targetPath: repoPath,
        exactBytes: 1_000,
        ownerId: packetId,
        ownerGeneration: generation,
        leaseExpiresAt: now + 60_000,
        policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
      });
    }
    const lane = createLane({
      repoPath,
      branch,
      runtime: 'codex',
      packetId,
      worktreePath,
    });
    for (const generation of [1, 2]) {
      recordLaneEvent(lane.id, 'update', 'orchestrator', {
        storageAdmissionOwnerGeneration: generation,
        storageAdmissionReservationId: `packet-storage:${packetId}:${generation}`,
      });
    }

    expect(() => deleteLane(lane.id)).toThrow(/before checkout removal is confirmed/);
    expect(getLane(lane.id)).not.toBeNull();
    expect(store.getReservation(`packet-storage:${packetId}:1`)?.state).toBe('reserved');
    expect(store.getReservation(`packet-storage:${packetId}:2`)?.state).toBe('reserved');

    await expect(cleanupAndDeleteLane(lane.id)).resolves.toMatchObject({ id: lane.id });
    expect(existsSync(worktreePath)).toBe(false);
    expect(getLane(lane.id)).toBeNull();
    expect(store.getReservation(`packet-storage:${packetId}:1`)?.state).toBe('released');
    expect(store.getReservation(`packet-storage:${packetId}:2`)?.state).toBe('released');
  });

  it('prunes a done task only after its checkout and reservation are settled', async () => {
    const packetId = 'task-prune-after-removal';
    const reservationId = `packet-storage:${packetId}:1`;
    const { repoPath, branch, worktreePath } = makeRepo(packetId);
    const now = Date.now();
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async (targetPath) => observed(targetPath, now),
    });
    await store.reserve({
      mutationId: `reserve-${packetId}`,
      reservationId,
      targetPath: repoPath,
      exactBytes: 2_000,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    const lane = createLane({ repoPath, branch, runtime: 'codex', packetId, worktreePath });
    recordLaneEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: reservationId,
    });
    const packet = terminalPacketWithAdmission({ packetId, reservationId, repoPath, worktreePath });
    packet.lane = { ...packet.lane!, laneId: lane.id };
    await withLockedState((state) => {
      state.missionId = 'mission-task-prune-storage';
      state.repoPath = repoPath;
      state.prompt = 'Task prune storage lifecycle';
      state.summary = 'Task prune storage lifecycle';
      state.runtime = 'codex';
      state.packets = [packet];
      state.updatedAt = new Date(now).toISOString();
      return null;
    });

    await expect(pruneTask(packetId, { repoPath })).resolves.toMatchObject({
      ok: true,
      action: 'prune',
      packetId,
    });
    expect(existsSync(worktreePath)).toBe(false);
    expect(getLane(lane.id)).toBeNull();
    expect(store.getReservation(reservationId)?.state).toBe('released');
    expect(readOrchestratorControlPlaneState().packets).toHaveLength(0);
  });

  it('retains an expired reservation when owner liveness is unknown', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-storage-expired-'));
    roots.push(repoPath);
    let now = 1_000;
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async (targetPath) => observed(targetPath, now),
    });
    await store.reserve({
      mutationId: 'reserve-expired-ownerless',
      reservationId: 'packet-storage:expired-ownerless:1',
      targetPath: repoPath,
      exactBytes: 2_000,
      ownerId: 'expired-ownerless',
      ownerGeneration: 1,
      leaseExpiresAt: 1_100,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });

    now = 2_000;
    await expect(reconcileExpiredPacketStorageReservations({
      store,
      now: () => now,
    })).resolves.toMatchObject({ inspected: 1, reconciled: 0, retainedUnknown: 1 });
    expect(store.getReservation('packet-storage:expired-ownerless:1')?.state).toBe('reserved');
  });

  it('reconciles an exact terminal generation only after checkout absence is proven', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-storage-terminal-reconcile-'));
    roots.push(repoPath);
    const packetId = 'expired-terminal-owner';
    const reservationId = 'packet-storage:expired-terminal-owner:1';
    let now = Date.now();
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async (targetPath) => observed(targetPath, now),
    });
    await store.reserve({
      mutationId: 'reserve-expired-terminal-owner',
      reservationId,
      targetPath: repoPath,
      exactBytes: 2_000,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: now + 100,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    now += 200;
    const reservation = store.getReservation(reservationId)!;
    const absentPacket = terminalPacketWithAdmission({
      packetId,
      reservationId,
      repoPath,
      worktreePath: join(repoPath, '.cortex-worktrees', `packet-${packetId}`),
    });

    await expect(resolveDurablePacketStorageOwner(reservation, [absentPacket]))
      .resolves.toMatchObject({ liveness: 'dead', source: 'terminal-packet-checkout' });
    await expect(reconcileExpiredPacketStorageReservations({
      store,
      now: () => now,
      resolveOwner: (candidate) => candidate.reservationId === reservationId
        ? resolveDurablePacketStorageOwner(candidate, [absentPacket])
        : { liveness: 'unknown', source: 'test-unrelated-owner', evidence: 'Unrelated row.' },
    })).resolves.toMatchObject({ reconciled: 1 });
    expect(store.getReservation(reservationId)?.state).toBe('reconciled');
  });

  it('retains an exact terminal generation while its checkout still exists', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-storage-terminal-live-'));
    roots.push(repoPath);
    const packetId = 'terminal-owner-with-checkout';
    const reservationId = 'packet-storage:terminal-owner-with-checkout:1';
    const now = Date.now();
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async (targetPath) => observed(targetPath, now),
    });
    await store.reserve({
      mutationId: 'reserve-terminal-owner-with-checkout',
      reservationId,
      targetPath: repoPath,
      exactBytes: 2_000,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    const packet = terminalPacketWithAdmission({
      packetId,
      reservationId,
      repoPath,
      worktreePath: repoPath,
    });

    await expect(resolveDurablePacketStorageOwner(store.getReservation(reservationId)!, [packet]))
      .resolves.toMatchObject({ liveness: 'alive', source: 'terminal-packet-checkout' });
    expect(store.getReservation(reservationId)?.state).toBe('reserved');
  });

  it('settles a no-lane reservation before its final durable packet record is removed', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-storage-packet-removal-'));
    roots.push(repoPath);
    const packetId = 'terminal-owner-without-lane';
    const reservationId = 'packet-storage:terminal-owner-without-lane:1';
    const now = Date.now();
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async (targetPath) => observed(targetPath, now),
    });
    await store.reserve({
      mutationId: 'reserve-terminal-owner-without-lane',
      reservationId,
      targetPath: repoPath,
      exactBytes: 2_000,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    const packet = terminalPacketWithAdmission({ packetId, reservationId, repoPath });

    await expect(settlePacketStorageBeforeRemoval(packet)).resolves.toBeUndefined();
    expect(store.getReservation(reservationId)?.state).toBe('released');
  });

  it('does not release a packet reservation while another lane for it is active', async () => {
    const packetId = 'terminal-with-live-successor';
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-storage-live-successor-'));
    roots.push(repoPath);
    const now = Date.now();
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async (targetPath) => observed(targetPath, now),
    });
    await store.reserve({
      mutationId: 'reserve-terminal-with-live-successor',
      reservationId: 'packet-storage:terminal-with-live-successor:1',
      targetPath: repoPath,
      exactBytes: 2_000,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    const oldLane = createLane({
      repoPath,
      branch: 'inline/terminal-old',
      runtime: 'codex',
      packetId,
    });
    const liveLane = createLane({
      repoPath,
      branch: 'inline/terminal-live',
      runtime: 'codex',
      packetId,
    });
    for (const lane of [oldLane, liveLane]) {
      recordLaneEvent(lane.id, 'update', 'orchestrator', {
        storageAdmissionOwnerGeneration: 1,
        storageAdmissionReservationId: 'packet-storage:terminal-with-live-successor:1',
      });
    }

    setLaneStatus(oldLane.id, 'completed', 'system', 'merged');
    expect(store.getReservation('packet-storage:terminal-with-live-successor:1')?.state).toBe('reserved');
    setLaneStatus(liveLane.id, 'completed', 'system', 'merged');
    expect(store.getReservation('packet-storage:terminal-with-live-successor:1')?.state).toBe('released');
  });

  it('names a terminal reservation with a retained checkout in a capacity hold', async () => {
    const gib = 1024 * 1024 * 1024;
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-storage-diagnostic-'));
    roots.push(repoPath);
    const packetId = 'diagnostic-terminal';
    const lane = createLane({
      repoPath,
      branch: 'inline/diagnostic-terminal',
      runtime: 'codex',
      packetId,
      worktreePath: repoPath,
    });
    setLaneStatus(lane.id, 'completed', 'system', 'merged');
    const now = Date.now();
    const observeVolume = async (targetPath: string): Promise<StorageVolumeObservation> => ({
      ...observed(targetPath, now),
      volumeId: 'device:diagnostic',
      availableBytes: 12 * gib,
      freeBytes: 12 * gib,
      totalBytes: 100 * gib,
    });
    const store = new StorageAdmissionStore(getSqlite(), { now: () => now, observeVolume });
    await store.reserve({
      mutationId: 'reserve-diagnostic-terminal',
      reservationId: 'packet-storage:diagnostic-terminal:1',
      targetPath: repoPath,
      exactBytes: 8 * gib,
      ownerId: packetId,
      ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0, absoluteFloorBytes: gib },
    });
    const candidate: OrchestratorPacket = {
      id: 'diagnostic-candidate',
      referenceLabel: 'diagnostic-candidate',
      title: 'diagnostic candidate',
      summary: 'diagnostic candidate',
      workspaceTargetPath: repoPath,
      branchTarget: 'inline/diagnostic-candidate',
      runtime: 'codex',
      dependencyLabels: [],
      dependencyPacketIds: [],
      queueState: 'queued',
      releaseState: 'pending',
      status: 'queued',
    };
    const admission = createPacketStorageAdmissionCoordinator({
      sqlite: getSqlite(),
      store,
      now: () => now,
      observeEstimate: async () => ({
        status: 'observed',
        exactBytes: 4 * gib,
        source: 'source-size-fallback',
        historySamples: 0,
        workspacePaths: [],
        error: null,
      }),
      resolveReservationTarget: (targetPath) => targetPath,
      observeReservationVolume: observeVolume,
      observeRootIdentity: async () => ({ canonicalPath: repoPath, device: '1', inode: '1' }),
      resolvePolicy: () => ({ reserveRatio: 0, absoluteFloorBytes: gib }),
    });

    await expect(admission.reserveForLaunch(candidate)).rejects.toThrow(
      '8.00 GB held by 1 terminal packet.',
    );
  });
});
