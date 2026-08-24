import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

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
 * records to carry the owner generation.
 *
 * `generationEvents` selects which real-world shape to persist:
 *  - `staggered` — generations recorded a second apart (the ordinary relaunch);
 *  - `tied` — both stamped at the identical millisecond, which `lane_events`
 *    permits and a fast relaunch produces;
 *  - `reversed` — a replay stamps the lower generation later than the higher;
 *  - `none` — reservations exist but the lane never recorded a generation, so
 *    no release scope is provable.
 */
async function seedLaunchedPacket(
  packetId: string,
  generations: number[],
  generationEvents: 'staggered' | 'tied' | 'reversed' | 'none' = 'staggered',
  withWorktree = false,
) {
  const repoPath = mkdtempSync(join(tmpdir(), `o8-storage-chokepoint-${packetId}-`));
  roots.push(repoPath);
  const worktreePath = join(repoPath, '.cortex-worktrees', `packet-${packetId}`);
  if (withWorktree) mkdirSync(worktreePath, { recursive: true });
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
    worktreePath: withWorktree ? worktreePath : undefined,
  });
  if (generationEvents !== 'none') {
    generations.forEach((generation, index) => {
      const event = recordLaneEvent(lane.id, 'update', 'orchestrator', {
        storageAdmissionOwnerGeneration: generation,
        storageAdmissionReservationId: reservationId(packetId, generation),
      });
      const offsetMs = generationEvents === 'tied'
        ? 0
        : generationEvents === 'reversed'
          ? (generations.length - index) * 1_000
          : index * 1_000;
      getSqlite()
        .prepare('UPDATE lane_events SET timestamp = ? WHERE id = ?')
        .run(new Date(now + offsetMs).toISOString(), event.id);
    });
  }
  return { lane, repoPath, store, worktreePath };
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
let clearInjectedFailure: (() => void) | null = null;

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
  clearInjectedFailure = () => {
    getSqlite().exec('DROP TRIGGER IF EXISTS poison_settlement');
    clearInjectedFailure = null;
  };
  return clearInjectedFailure;
}

// The trigger is shared process state on one connection. An assertion that fails
// before its in-test `clearFailure()` would otherwise leave settlement poisoned
// for every later test in the file, turning one real failure into a cascade of
// fake ones — so teardown owns the drop and the in-test call is just early.
afterEach(() => {
  clearInjectedFailure?.();
});

afterAll(() => {
  closeDb();
  for (const root of roots.reverse()) rmSync(root, { recursive: true, force: true });
});

describe('lane packet-association chokepoint releases storage reservations', () => {
  it('retains a failed lane reservation while its checkout still exists', async () => {
    const packetId = 'chokepoint-failed-with-checkout';
    const { lane, worktreePath } = await seedLaunchedPacket(packetId, [1], 'staggered', true);

    setLaneStatus(lane.id, 'failed', 'system', 'launch_attempts_exhausted');

    expect(existsSync(worktreePath)).toBe(true);
    expect(reservationStates(packetId, [1])).toEqual(['reserved']);

    rmSync(worktreePath, { recursive: true, force: true });
    updateLane(lane.id, { packetId: '' }, 'system');
    expect(reservationStates(packetId, [1])).toEqual(['released']);
  });

  it('releases a failed launch when no checkout exists', async () => {
    const packetId = 'chokepoint-failed';
    const { lane } = await seedLaunchedPacket(packetId, [1]);

    // Exact call commands-launch.ts makes when a launch is abandoned.
    setLaneStatus(lane.id, 'failed', 'system', 'launch_attempts_exhausted');

    expect(reservationStates(packetId, [1])).toEqual(['released']);
  });

  it('releases when rerun unbinds the packet before archiving the lane', async () => {
    const packetId = 'chokepoint-rerun-unbind';
    const { lane } = await seedLaunchedPacket(packetId, [1]);

    // Legacy lane-rebind helper; the unbind crosses the production updateLane
    // chokepoint that every current caller shares.
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

  it('releases both generations when the two generation events share a timestamp', async () => {
    const packetId = 'chokepoint-tied-timestamps';
    const { lane } = await seedLaunchedPacket(packetId, [1, 2], 'tied');

    // Both `update` events carry the identical millisecond, so SQLite is free to
    // return either first. Picking the newest ROW resolves to generation 1 here
    // and scopes the release to `<= 1`, stranding generation 2's reserved bytes.
    // The authoritative generation is the MAXIMUM, which no row order can move.
    setLaneStatus(lane.id, 'failed', 'system', 'launch_attempts_exhausted');

    expect(reservationStates(packetId, [1, 2])).toEqual(['released', 'released']);
  });

  it('does not let a later replay of an older generation narrow the release scope', async () => {
    const packetId = 'chokepoint-reversed-timestamps';
    const { lane } = await seedLaunchedPacket(packetId, [1, 2], 'reversed');

    setLaneStatus(lane.id, 'failed', 'system', 'launch_attempts_exhausted');

    expect(reservationStates(packetId, [1, 2])).toEqual(['released', 'released']);
  });

  it('scopes a reused lane generation to its current packet owner', async () => {
    const packetId = 'chokepoint-current-owner';
    const stalePacketId = 'chokepoint-stale-owner';
    const { lane, repoPath, store } = await seedLaunchedPacket(packetId, [1, 2, 3], 'none');
    await store.reserve({
      mutationId: `reserve-${stalePacketId}-5`,
      reservationId: reservationId(stalePacketId, 5),
      targetPath: repoPath,
      exactBytes: 1_000,
      ownerId: stalePacketId,
      ownerGeneration: 5,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });
    const currentEvent = recordLaneEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: reservationId(packetId, 1),
    });
    const staleEvent = recordLaneEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 5,
      storageAdmissionReservationId: reservationId(stalePacketId, 5),
    });
    getSqlite().prepare('UPDATE lane_events SET timestamp = ? WHERE id = ?')
      .run(new Date(now).toISOString(), currentEvent.id);
    getSqlite().prepare('UPDATE lane_events SET timestamp = ? WHERE id = ?')
      .run(new Date(now + 2_000).toISOString(), staleEvent.id);
    const newerSibling = createLane({
      repoPath,
      branch: `inline/${packetId}-newer`,
      runtime: 'codex',
      packetId,
      label: `packet ${packetId} newer`,
    });
    recordLaneEvent(newerSibling.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 2,
      storageAdmissionReservationId: reservationId(packetId, 2),
    });

    updateLane(lane.id, { packetId: '' }, 'system');

    expect(reservationStates(packetId, [1, 2, 3])).toEqual(['released', 'reserved', 'reserved']);
    expect(store.getReservation(reservationId(stalePacketId, 5))?.state).toBe('reserved');
    expect(getLane(newerSibling.id)?.packetId).toBe(packetId);
  });

  it('releases only the current generation when an older live sibling remains', async () => {
    const packetId = 'chokepoint-older-sibling';
    const { lane, repoPath } = await seedLaunchedPacket(packetId, [1, 2]);
    const olderSibling = createLane({
      repoPath,
      branch: `inline/${packetId}-older`,
      runtime: 'codex',
      packetId,
      label: `packet ${packetId} older`,
    });
    recordLaneEvent(olderSibling.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: reservationId(packetId, 1),
    });

    updateLane(lane.id, { packetId: '' }, 'system');

    expect(reservationStates(packetId, [1, 2])).toEqual(['reserved', 'released']);
    expect(getLane(olderSibling.id)?.packetId).toBe(packetId);
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

describe('an unprovable release scope fails the association-losing write closed', () => {
  it('rejects an unbind when one reserved generation has no proven owner generation', async () => {
    const packetId = 'chokepoint-unproven-single';
    const { lane } = await seedLaunchedPacket(packetId, [1], 'none');

    // Succeeding here is the defect: the reassignment would commit while the
    // reserved row keeps holding headroom under an owner nothing points at.
    expect(() => updateLane(lane.id, { packetId: 'pkt-unproven-successor' }, 'system'))
      .toThrow(/unprovable/);

    expect(getLane(lane.id)?.packetId).toBe(packetId);
    expect(reservationStates(packetId, [1])).toEqual(['reserved']);
  });

  it('rejects a delete when several reserved generations have no proven owner generation', async () => {
    const packetId = 'chokepoint-unproven-multi';
    const { lane } = await seedLaunchedPacket(packetId, [1, 2], 'none');

    expect(() => deleteLane(lane.id)).toThrow(/unprovable/);

    expect(getLane(lane.id)?.packetId).toBe(packetId);
    expect(getLaneEvents(lane.id, 50).length).toBeGreaterThan(0);
    expect(reservationStates(packetId, [1, 2])).toEqual(['reserved', 'reserved']);
  });

  it('rejects loss of the last association when a newer generation is reserved', async () => {
    const packetId = 'chokepoint-newer-unbound';
    const { lane } = await seedLaunchedPacket(packetId, [1, 2], 'none');
    recordLaneEvent(lane.id, 'update', 'orchestrator', {
      storageAdmissionOwnerGeneration: 1,
      storageAdmissionReservationId: reservationId(packetId, 1),
    });

    expect(() => updateLane(lane.id, { packetId: '' }, 'system'))
      .toThrow(/newer reserved generation/);

    expect(getLane(lane.id)?.packetId).toBe(packetId);
    expect(reservationStates(packetId, [1, 2])).toEqual(['reserved', 'reserved']);
  });

  it('allows the ambiguous lane to unbind while a live sibling still names the packet', async () => {
    const packetId = 'chokepoint-unproven-sibling';
    const { lane, repoPath } = await seedLaunchedPacket(packetId, [1, 2], 'none');
    const sibling = createLane({
      repoPath,
      branch: `inline/${packetId}-sibling`,
      runtime: 'codex',
      packetId,
      label: `packet ${packetId} sibling`,
    });

    // Association survives on the sibling, so the reservations stay reachable
    // and this lane may drop its binding without stranding anything.
    updateLane(lane.id, { packetId: '' }, 'system');

    expect(getLane(lane.id)?.packetId ?? '').toBe('');
    expect(getLane(sibling.id)?.packetId).toBe(packetId);
    expect(reservationStates(packetId, [1, 2])).toEqual(['reserved', 'reserved']);
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
