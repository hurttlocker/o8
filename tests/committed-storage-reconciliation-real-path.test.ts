import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV38StorageAdmissionSchema } from '@/lib/db/v38-storage-admission-migration';
import type { LaneStatus } from '@/lib/lane/types';
import {
  reconcileCommittedPacketStorageReservations,
  resolveCommittedPacketStorageOwner,
} from '@/lib/orchestrator/committed-storage-reconciliation';
import type { OrchestratorPacket } from '@/lib/orchestrator/types';
import {
  StorageAdmissionStore,
  type StorageReservationRecord,
  type StorageVolumeObservation,
} from '@/lib/workspace/storage-admission';
import { managedPacketWorktreeId } from '@/lib/worktree/root-layout';

const roots: string[] = [];
const databases: Database.Database[] = [];

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'o8-committed-reconcile-'));
  roots.push(root);
  const targetPath = path.join(root, 'worktrees');
  mkdirSync(targetPath);
  const sqlite = new Database(path.join(root, 'ledger.db'));
  databases.push(sqlite);
  ensureV38StorageAdmissionSchema(sqlite);
  return { root, targetPath, sqlite };
}

function observed(targetPath: string, now: number): StorageVolumeObservation {
  return {
    status: 'observed',
    targetPath,
    probePath: targetPath,
    volumeId: 'device:committed-reconcile',
    availableBytes: 900_000,
    freeBytes: 900_000,
    totalBytes: 1_000_000,
    observedAt: now,
    error: null,
  };
}

async function committedReservation(input: {
  sqlite: Database.Database;
  targetPath: string;
  ownerId: string;
  now: number;
}): Promise<StorageReservationRecord> {
  const store = new StorageAdmissionStore(input.sqlite, {
    now: () => input.now,
    observeVolume: async (targetPath) => observed(targetPath, input.now),
  });
  const reservationId = `packet-storage:${input.ownerId}:1`;
  await store.reserve({
    mutationId: `reserve:${input.ownerId}`,
    reservationId,
    targetPath: input.targetPath,
    exactBytes: 2_000,
    ownerId: input.ownerId,
    ownerGeneration: 1,
    leaseExpiresAt: input.now + 60_000,
    policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
  });
  await store.commit({
    mutationId: `commit:${input.ownerId}`,
    reservationId,
    volumeId: 'device:committed-reconcile',
    ownerId: input.ownerId,
    ownerGeneration: 1,
    expectedGeneration: 1,
  });
  return store.getReservation(reservationId)!;
}

function packet(
  id: string,
  status: OrchestratorPacket['status'],
  worktreePath: string | null = null,
): OrchestratorPacket {
  return {
    id,
    title: id,
    prompt: id,
    status,
    releaseState: status === 'archived' ? 'released' : 'pending',
    archivedAt: status === 'archived' ? new Date(1_000).toISOString() : null,
    lane: worktreePath ? { laneId: `lane-${id}`, worktreePath } : null,
  } as OrchestratorPacket;
}

function lane(
  ownerId: string,
  status: LaneStatus,
  worktreePath: string | null = null,
) {
  return { id: `lane-${ownerId}`, packetId: ownerId, status, worktreePath };
}

describe('committed packet storage reconciliation real path', () => {
  it('atomically releases a terminal owner after checkout absence and records one immutable receipt', async () => {
    const { sqlite, targetPath } = fixture();
    const now = 10_000;
    const ownerId = 'terminal-owner';
    const reservation = await committedReservation({ sqlite, targetPath, ownerId, now });
    const terminalPacket = packet(ownerId, 'archived');

    const first = await reconcileCommittedPacketStorageReservations({
      sqlite,
      now: () => now,
      resolveOwner: (candidate) => resolveCommittedPacketStorageOwner(candidate, {
        lanes: [lane(ownerId, 'archived')],
        packets: [terminalPacket],
      }),
    });
    expect(first).toEqual({
      inspected: 1,
      released: 1,
      releasedBytes: 2_000,
      retainedLive: 0,
      retainedUnknown: 0,
      held: 0,
    });
    expect(sqlite.prepare(`
      SELECT state, generation, last_reason FROM storage_admission_reservations
      WHERE reservation_id = ?
    `).get(reservation.reservationId)).toEqual({
      state: 'released',
      generation: 3,
      last_reason: 'released',
    });
    expect(sqlite.prepare(`
      SELECT operation, COUNT(*) AS count FROM storage_admission_mutations
      WHERE reservation_id = ? AND operation = 'release'
    `).get(reservation.reservationId)).toEqual({ operation: 'release', count: 1 });
    expect(() => sqlite.prepare(`
      DELETE FROM storage_admission_mutations WHERE reservation_id = ? AND operation = 'release'
    `).run(reservation.reservationId)).toThrow(/append-only/);

    await expect(reconcileCommittedPacketStorageReservations({ sqlite, now: () => now + 1 }))
      .resolves.toMatchObject({ inspected: 0, released: 0 });
    expect(sqlite.prepare(`
      SELECT COUNT(*) FROM storage_admission_mutations
      WHERE reservation_id = ? AND operation = 'release'
    `).pluck().get(reservation.reservationId)).toBe(1);
  });

  it('retains a committed row while its durable packet is nonterminal', async () => {
    const { sqlite, targetPath } = fixture();
    const ownerId = 'live-owner';
    const reservation = await committedReservation({ sqlite, targetPath, ownerId, now: 20_000 });

    await expect(reconcileCommittedPacketStorageReservations({
      sqlite,
      now: () => 20_000,
      resolveOwner: (candidate) => resolveCommittedPacketStorageOwner(candidate, {
        lanes: [lane(ownerId, 'archived')],
        packets: [packet(ownerId, 'running')],
      }),
    })).resolves.toMatchObject({ released: 0, retainedLive: 1 });
    expect(sqlite.prepare(`
      SELECT state FROM storage_admission_reservations WHERE reservation_id = ?
    `).pluck().get(reservation.reservationId)).toBe('committed');
  });

  it('retains a terminal owner while a suffixed packet checkout still exists', async () => {
    const { sqlite, targetPath } = fixture();
    const ownerId = 'terminal-present-owner';
    const reservation = await committedReservation({ sqlite, targetPath, ownerId, now: 30_000 });
    mkdirSync(path.join(targetPath, `${managedPacketWorktreeId(ownerId)}-retry`));

    await expect(reconcileCommittedPacketStorageReservations({
      sqlite,
      now: () => 30_000,
      resolveOwner: (candidate) => resolveCommittedPacketStorageOwner(candidate, {
        lanes: [lane(ownerId, 'archived')],
        packets: [packet(ownerId, 'archived')],
      }),
    })).resolves.toMatchObject({ released: 0, retainedLive: 1 });
    expect(sqlite.prepare(`
      SELECT state FROM storage_admission_reservations WHERE reservation_id = ?
    `).pluck().get(reservation.reservationId)).toBe('committed');
  });

  it('releases an owner absent from both durable ledgers when its admitted root is gone', async () => {
    const { sqlite, targetPath } = fixture();
    const ownerId = 'absent-owner';
    await committedReservation({ sqlite, targetPath, ownerId, now: 40_000 });
    rmSync(targetPath, { recursive: true });

    await expect(reconcileCommittedPacketStorageReservations({
      sqlite,
      now: () => 40_000,
      resolveOwner: (candidate) => resolveCommittedPacketStorageOwner(candidate, {
        lanes: [],
        packets: [],
      }),
    })).resolves.toMatchObject({ inspected: 1, released: 1, releasedBytes: 2_000 });
  });

  it('rolls the release back when its immutable receipt cannot be appended', async () => {
    const { sqlite, targetPath } = fixture();
    const ownerId = 'receipt-failure-owner';
    const reservation = await committedReservation({ sqlite, targetPath, ownerId, now: 50_000 });
    sqlite.exec(`
      CREATE TRIGGER reject_committed_release_receipt
      BEFORE INSERT ON storage_admission_mutations
      WHEN NEW.operation = 'release'
      BEGIN
        SELECT RAISE(ABORT, 'release receipt blocked');
      END;
    `);

    await expect(reconcileCommittedPacketStorageReservations({
      sqlite,
      now: () => 50_000,
      resolveOwner: (candidate) => resolveCommittedPacketStorageOwner(candidate, {
        lanes: [lane(ownerId, 'archived')],
        packets: [packet(ownerId, 'archived')],
      }),
    })).rejects.toThrow(/release receipt blocked/);
    expect(sqlite.prepare(`
      SELECT state, generation FROM storage_admission_reservations WHERE reservation_id = ?
    `).get(reservation.reservationId)).toEqual({ state: 'committed', generation: 2 });
  });
});
