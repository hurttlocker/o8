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
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { recordLaneEvent } = await import('@/lib/lane/events');
const { sweepTerminalCortexWorktrees } = await import('@/lib/lane/terminal-worktree-sweep');
const {
  createPacketStorageAdmissionCoordinator,
  reconcileExpiredPacketStorageReservations,
} = await import('@/lib/orchestrator/storage-admission');
const {
  StorageAdmissionStore,
} = await import('@/lib/workspace/storage-admission');

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

  it('names terminal packet reservations in a capacity hold', async () => {
    const gib = 1024 * 1024 * 1024;
    const repoPath = mkdtempSync(join(tmpdir(), 'o8-storage-diagnostic-'));
    roots.push(repoPath);
    const packetId = 'diagnostic-terminal';
    const lane = createLane({
      repoPath,
      branch: 'inline/diagnostic-terminal',
      runtime: 'codex',
      packetId,
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
