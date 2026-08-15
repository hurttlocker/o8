import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV38StorageAdmissionSchema } from '@/lib/db/v38-storage-admission-migration';
import type { StorageVolumeObservation } from '@/lib/workspace/storage-admission';
import { readPacketStorageAdmissionProjection } from './storage-admission-projection';

const databases: Database.Database[] = [];

function sqlite(): Database.Database {
  const db = new Database(':memory:');
  ensureV38StorageAdmissionSchema(db);
  databases.push(db);
  return db;
}

function insertReservation(
  db: Database.Database,
  reservationId: string,
  volumeId: string,
  exactBytes: number,
): void {
  db.prepare(`
    INSERT INTO storage_admission_reservations (
      reservation_id, volume_id, target_path, exact_bytes, owner_id,
      owner_generation, generation, state, lease_expires_at,
      pre_measurement_json, last_mutation_id, last_reason, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, 1, 'reserved', 10000, '{}', ?, 'admitted', 1, 1)
  `).run(
    reservationId,
    volumeId,
    `/targets/${volumeId}`,
    exactBytes,
    reservationId,
    `reserve:${reservationId}`,
  );
}

function observation(
  targetPath: string,
  volumeId: string,
  availableBytes: number,
  totalBytes: number,
): StorageVolumeObservation {
  return {
    status: 'observed',
    targetPath,
    probePath: targetPath,
    volumeId,
    availableBytes,
    freeBytes: availableBytes,
    totalBytes,
    observedAt: 1,
    error: null,
  };
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('packet storage admission projection', () => {
  it('deduplicates two observed volumes and never charges an unrepresented reservation to them', async () => {
    const db = sqlite();
    insertReservation(db, 'a-1', 'device:a', 100);
    insertReservation(db, 'a-2', 'device:a', 50);
    insertReservation(db, 'b-1', 'device:b', 200);
    insertReservation(db, 'unrepresented', 'device:c', 400);
    const observeVolume = async (targetPath: string) => targetPath.startsWith('/volume-a')
      ? observation(targetPath, 'device:a', 1_000, 1_000)
      : observation(targetPath, 'device:b', 2_000, 2_000);
    const dependencies = {
      sqlite: db,
      observeVolume,
      resolvePolicy: () => ({ reserveRatio: 0.1, absoluteFloorBytes: 50 }),
    };

    const partial = await readPacketStorageAdmissionProjection(
      ['/volume-a/one', '/volume-a/two', '/volume-b/one'],
      dependencies,
    );
    expect(partial).toMatchObject({
      accountingStatus: 'partial',
      physicalAvailableBytes: 3_000,
      reservedBytes: 350,
      requiredReserveBytes: 300,
      dispatchHeadroomBytes: null,
      activeReservations: 3,
    });

    db.prepare("UPDATE storage_admission_reservations SET state = 'released' WHERE volume_id = 'device:c'").run();
    const observed = await readPacketStorageAdmissionProjection(
      ['/volume-a/one', '/volume-a/two', '/volume-b/one'],
      dependencies,
    );
    expect(observed).toMatchObject({
      accountingStatus: 'observed',
      physicalAvailableBytes: 3_000,
      reservedBytes: 350,
      requiredReserveBytes: 300,
      dispatchHeadroomBytes: 2_350,
      activeReservations: 3,
    });
  });
});
