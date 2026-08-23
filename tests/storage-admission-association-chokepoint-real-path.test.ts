import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { StorageVolumeObservation } from '@/lib/workspace/storage-admission';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-storage-chokepoint-data-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, deleteLane, getLane, getLaneEvents, setLaneStatus, updateLane } = await import(
  '@/lib/lane/registry'
);
const { recordLaneEvent } = await import('@/lib/lane/events');
const { archiveLanesForPacket } = await import(
  '@/lib/orchestrator/operator-mission-service/rerun-with-feedback'
);
const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');

const roots: string[] = [dataDir];
const now = Date.now();

function observed(targetPath: string): StorageVolumeObservation {
  return {
    status: 'observed',
    targetPath,
    probePath: targetPath,
    // One synthetic volume per seeded repo: headroom is what each case is
    // asserting on, so tests must not consume each other's.
    volumeId: `device:chokepoint-test:${targetPath}`,
    availableBytes: 10_000,
    freeBytes: 10_000,
    totalBytes: 20_000,
    observedAt: now,
    error: null,
  };
}

function makeStore() {
  return new StorageAdmissionStore(getSqlite(), {
    now: () => now,
    observeVolume: async (targetPath) => observed(targetPath),
  });
}

function reservationId(packetId: string, generation: number) {
  return `packet-storage:${packetId}:${generation}`;
}

/**
 * Persist the exact state a real dispatch leaves behind: `reserved` rows owned
 * by the packet plus the lane `update` events `launchPacketWithStorageAdmission`
 * records to carry the owner generation. Event timestamps are stamped apart so
 * "latest generation wins" is deterministic rather than a same-millisecond tie.
 */
async function seedLaunchedPacket(packetId: string, generations: number[]) {
  const repoPath = mkdtempSync(join(tmpdir(), `o8-storage-chokepoint-${packetId}-`));
  roots.push(repoPath);
  const store = makeStore();
  for (const generation of generations) {
    await store.reserve({
      mutationId: `reserve-${packetId}-${generation}`,
      reservationId: reservationId(packetId, generation),
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
    branch: `inline/${packetId}`,
    runtime: 'codex',
    packetId,
    label: `packet ${packetId}`,
  });
  generations.forEach((generation, index) => {
    const event = recordLaneEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: generation,
      storageAdmissionReservationId: reservationId(packetId, generation),
    });
    getSqlite()
      .prepare('UPDATE lane_events SET timestamp = ? WHERE id = ?')
      .run(new Date(now + index * 1_000).toISOString(), event.id);
  });
  return { lane, repoPath, store };
}

function reservationStates(packetId: string, generations: number[]) {
  const store = makeStore();
  return generations.map(
    (generation) => store.getReservation(reservationId(packetId, generation))?.state,
  );
}

/**
 * Failure injection with no test-only production branch: a SQLite trigger that
 * aborts the release UPDATE for one reservation. Settlement then throws from
 * inside the lane transaction exactly as a real storage-layer fault would.
 * Dropping the trigger models the fault clearing, which is what makes the
 * "still recoverable" half of the assertion meaningful.
 */
function injectSettlementFailure(targetReservationId: string) {
  getSqlite().exec(`
    CREATE TRIGGER poison_settlement
    BEFORE UPDATE OF state ON storage_admission_reservations
    FOR EACH ROW WHEN NEW.state = 'released'
      AND OLD.reservation_id = '${targetReservationId}'
    BEGIN
      SELECT RAISE(ABORT, 'injected settlement failure');
    END;
  `);
  return () => getSqlite().exec('DROP TRIGGER poison_settlement');
}

afterAll(() => {
  closeDb();
  for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
});

describe('lane packet-association chokepoint releases storage reservations', () => {
  it('releases when a launch failure takes the lane to failed', async () => {
    const packetId = 'chokepoint-failed';
    const { lane } = await seedLaunchedPacket(packetId, [1]);

    // Exact call commands-launch.ts makes when a launch is abandoned.
    setLaneStatus(lane.id, 'failed', 'system', 'launch_attempts_exhausted');

    expect(reservationStates(packetId, [1])).toEqual(['released']);
  });

  it('releases when rerun unbinds the packet before archiving the lane', async () => {
    const packetId = 'chokepoint-rerun-unbind';
    const { lane } = await seedLaunchedPacket(packetId, [1]);

    // Real production entry point (#1214 lane-rebind path).
    archiveLanesForPacket(packetId, packetId);

    expect(getLane(lane.id)?.packetId ?? '').toBe('');
    expect(reservationStates(packetId, [1])).toEqual(['released']);
  });

  it('releases the prior owner when a lane is reassigned to a retry packet', async () => {
    const packetId = 'chokepoint-reassign';
    const { lane } = await seedLaunchedPacket(packetId, [1]);

    // Exact call the ws-server bounded-retry handoff makes.
    updateLane(lane.id, { packetId: 'pkt-retry-successor' }, 'system');

    expect(getLane(lane.id)?.packetId).toBe('pkt-retry-successor');
    expect(reservationStates(packetId, [1])).toEqual(['released']);
  });

  it('releases every generation when deleteLane drops the lane events first', async () => {
    const packetId = 'chokepoint-delete';
    const { lane } = await seedLaunchedPacket(packetId, [1, 2]);

    deleteLane(lane.id);

    expect(getLane(lane.id)).toBeNull();
    expect(reservationStates(packetId, [1, 2])).toEqual(['released', 'released']);
  });

  it('restores dispatch headroom once the association-loss release lands', async () => {
    const packetId = 'chokepoint-headroom';
    const { lane, repoPath } = await seedLaunchedPacket(packetId, [1]);
    const store = makeStore();

    const blocked = await store.reserve({
      mutationId: 'reserve-chokepoint-headroom-blocked',
      reservationId: 'packet-storage:chokepoint-headroom-next:1',
      targetPath: repoPath,
      exactBytes: 8_000,
      ownerId: 'chokepoint-headroom-next',
      ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    expect(blocked.decision).toBe('held');
    expect(blocked.reason).toBe('reserve_breached');

    setLaneStatus(lane.id, 'failed', 'system', 'launch_attempts_exhausted');

    const admitted = await store.reserve({
      mutationId: 'reserve-chokepoint-headroom-admitted',
      reservationId: 'packet-storage:chokepoint-headroom-next:2',
      targetPath: repoPath,
      exactBytes: 8_000,
      ownerId: 'chokepoint-headroom-next',
      ownerGeneration: 2,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    expect(admitted.decision).toBe('reserved');
    expect(admitted.activeReservedBytes).toBe(0);
  });
});

describe('settlement failure rolls the association-losing lane write back', () => {
  it('keeps the lane bound and non-terminal when the terminal transition cannot settle', async () => {
    const packetId = 'chokepoint-rollback-update';
    const { lane } = await seedLaunchedPacket(packetId, [1, 2]);
    // Poison the SECOND reservation only: the first one is released before the
    // fault fires, so a non-atomic implementation would leave a half-settled
    // owner behind.
    const clearFailure = injectSettlementFailure(reservationId(packetId, 2));

    expect(() => setLaneStatus(lane.id, 'failed', 'system', 'launch_attempts_exhausted'))
      .toThrow(/injected settlement failure/);

    const rolledBack = getLane(lane.id);
    expect(rolledBack?.status).not.toBe('failed');
    expect(rolledBack?.packetId).toBe(packetId);
    expect(reservationStates(packetId, [1, 2])).toEqual(['reserved', 'reserved']);

    // Still reachable through the same chokepoint once the fault clears.
    clearFailure();
    setLaneStatus(lane.id, 'failed', 'system', 'launch_attempts_exhausted');
    expect(getLane(lane.id)?.status).toBe('failed');
    expect(reservationStates(packetId, [1, 2])).toEqual(['released', 'released']);
  });

  it('keeps the lane row and its events when a delete cannot settle', async () => {
    const packetId = 'chokepoint-rollback-delete';
    const { lane } = await seedLaunchedPacket(packetId, [1, 2]);
    const clearFailure = injectSettlementFailure(reservationId(packetId, 2));

    expect(() => deleteLane(lane.id)).toThrow(/injected settlement failure/);

    expect(getLane(lane.id)?.packetId).toBe(packetId);
    expect(getLaneEvents(lane.id, 50).length).toBeGreaterThan(0);
    expect(reservationStates(packetId, [1, 2])).toEqual(['reserved', 'reserved']);

    clearFailure();
    deleteLane(lane.id);
    expect(getLane(lane.id)).toBeNull();
    expect(reservationStates(packetId, [1, 2])).toEqual(['released', 'released']);
  });
});
