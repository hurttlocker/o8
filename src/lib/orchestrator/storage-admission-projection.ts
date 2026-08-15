import 'server-only';

import path from 'node:path';
import type Database from 'better-sqlite3';

import { getSqlite } from '@/lib/db';
import { getOperatorDefaultsSync } from '@/lib/operator/defaults';
import {
  observeStorageVolume,
  type StorageVolumeObservation,
} from '@/lib/workspace/storage-admission';

const GIB = 1024 * 1024 * 1024;

export interface PacketStorageAdmissionProjection {
  accountingStatus: 'observed' | 'partial' | 'unknown';
  reserveRatio: number;
  absoluteFloorBytes: number;
  physicalAvailableBytes: number | null;
  reservedBytes: number | null;
  requiredReserveBytes: number | null;
  dispatchHeadroomBytes: number | null;
  activeReservations: number;
}

interface ActiveVolumeRow {
  volume_id: string;
  count: number;
  bytes: number;
}

interface ProjectionDependencies {
  sqlite?: Database.Database;
  observeVolume?: (targetPath: string) => Promise<StorageVolumeObservation>;
  resolvePolicy?: () => { reserveRatio: number; absoluteFloorBytes: number };
}

export async function readPacketStorageAdmissionProjection(
  targetPaths: string[],
  dependencies: ProjectionDependencies = {},
): Promise<PacketStorageAdmissionProjection> {
  const policy = dependencies.resolvePolicy?.() ?? (() => {
    const values = getOperatorDefaultsSync().values;
    return {
      reserveRatio: values.storageReserveRatio,
      absoluteFloorBytes: Math.round(values.storageReserveFloorGb * GIB),
    };
  })();
  const uniquePaths = [...new Set(targetPaths.map((candidate) => path.resolve(candidate)))];
  const active = (dependencies.sqlite ?? getSqlite()).prepare(`
    SELECT volume_id, COUNT(*) AS count, COALESCE(SUM(exact_bytes), 0) AS bytes
    FROM storage_admission_reservations WHERE state = 'reserved'
    GROUP BY volume_id
  `).all() as ActiveVolumeRow[];
  const observe = dependencies.observeVolume ?? ((target: string) => observeStorageVolume(target));
  const observations = await Promise.all(uniquePaths.map((target) => observe(target)));
  const uniqueVolumes = [...new Map(
    observations
      .filter((item) => item.status === 'observed' && item.volumeId)
      .map((item) => [item.volumeId!, item]),
  ).values()];
  const volumeIds = new Set(uniqueVolumes.map((item) => item.volumeId!));
  const represented = active.filter((item) => volumeIds.has(item.volume_id));
  const hasUnrepresentedReservations = represented.length !== active.length;
  const observationUnknown = observations.length === 0
    || observations.some((item) => item.status !== 'observed' || !item.volumeId);
  const physicalAvailableBytes = observationUnknown
    ? null
    : uniqueVolumes.reduce((sum, item) => sum + (item.availableBytes ?? 0), 0);
  const requiredReserveBytes = observationUnknown
    ? null
    : uniqueVolumes.reduce((sum, item) => sum + Math.max(
      policy.absoluteFloorBytes,
      Math.ceil((item.totalBytes ?? 0) * policy.reserveRatio),
    ), 0);
  const reservedBytes = represented.reduce((sum, item) => sum + item.bytes, 0);
  const activeReservations = represented.reduce((sum, item) => sum + item.count, 0);
  const incomplete = observationUnknown || hasUnrepresentedReservations;
  return {
    accountingStatus: observationUnknown
      ? (active.length > 0 ? 'partial' : 'unknown')
      : hasUnrepresentedReservations ? 'partial' : 'observed',
    reserveRatio: policy.reserveRatio,
    absoluteFloorBytes: policy.absoluteFloorBytes,
    physicalAvailableBytes,
    reservedBytes: Number.isSafeInteger(reservedBytes) ? reservedBytes : null,
    requiredReserveBytes,
    dispatchHeadroomBytes: incomplete
      || physicalAvailableBytes === null
      || requiredReserveBytes === null
      || !Number.isSafeInteger(reservedBytes)
      ? null
      : physicalAvailableBytes - requiredReserveBytes - reservedBytes,
    activeReservations,
  };
}
