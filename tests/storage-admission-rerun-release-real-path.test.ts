import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import type { StorageVolumeObservation } from '@/lib/workspace/storage-admission';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-storage-rerun-release-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;

const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, getLane, setLaneStatus } = await import('@/lib/lane/registry');
const { archiveLanesForPacket } = await import(
  '@/lib/orchestrator/operator-mission-service/rerun-with-feedback'
);
const { StorageAdmissionStore } = await import('@/lib/workspace/storage-admission');

afterAll(() => {
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('storage reservation release through rerun retirement', () => {
  it('releases a lane-owned reservation after rerun clears packetId before archive', async () => {
    const packetId = 'rerun-cleared-packet';
    const lane = createLane({
      repoPath: dataDir,
      branch: 'inline/rerun-cleared-packet',
      runtime: 'codex',
      packetId,
    });
    setLaneStatus(lane.id, 'running', 'system');
    const now = Date.now();
    const observation: StorageVolumeObservation = {
      status: 'observed',
      targetPath: dataDir,
      probePath: dataDir,
      volumeId: 'device:rerun-release',
      availableBytes: 10_000,
      freeBytes: 10_000,
      totalBytes: 20_000,
      observedAt: now,
      error: null,
    };
    const store = new StorageAdmissionStore(getSqlite(), {
      now: () => now,
      observeVolume: async () => observation,
    });
    await store.reserve({
      mutationId: 'reserve-rerun-cleared-packet',
      reservationId: `packet-storage:${lane.id}:1`,
      targetPath: dataDir,
      exactBytes: 2_000,
      ownerId: lane.id,
      ownerGeneration: 1,
      leaseExpiresAt: now + 60_000,
      policy: { reserveRatio: 0.1, absoluteFloorBytes: 1_000 },
    });

    archiveLanesForPacket(packetId, 'rerun-cleared-packet');

    expect(getLane(lane.id)).toMatchObject({ status: 'archived', packetId: '' });
    expect(store.getReservation(`packet-storage:${lane.id}:1`)?.state).toBe('released');
  });
});
