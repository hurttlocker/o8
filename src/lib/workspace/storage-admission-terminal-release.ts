import 'server-only';

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import type {
  StorageAdmissionResult,
  StorageReservationRecord,
  StorageReservationState,
  StorageRootIdentity,
  StorageVolumeObservation,
} from './storage-admission';

interface ReservationRow {
  reservation_id: string;
  volume_id: string;
  target_path: string;
  root_identity_json: string | null;
  exact_bytes: number;
  owner_id: string;
  owner_generation: number;
  generation: number;
  state: StorageReservationState;
  lease_expires_at: number;
  pre_measurement_json: string;
  post_measurement_json: string | null;
  last_mutation_id: string;
  last_reason: string;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

export interface TerminalOwnerStorageReleaseResult {
  released: number;
  releasedBytes: number;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required.`);
  return normalized;
}

function mapReservation(row: ReservationRow): StorageReservationRecord {
  return {
    reservationId: row.reservation_id,
    volumeId: row.volume_id,
    targetPath: row.target_path,
    rootIdentity: row.root_identity_json ? JSON.parse(row.root_identity_json) as StorageRootIdentity : null,
    exactBytes: row.exact_bytes,
    ownerId: row.owner_id,
    ownerGeneration: row.owner_generation,
    generation: row.generation,
    state: row.state,
    leaseExpiresAt: row.lease_expires_at,
    preMeasurement: JSON.parse(row.pre_measurement_json) as StorageVolumeObservation,
    postMeasurement: row.post_measurement_json
      ? JSON.parse(row.post_measurement_json) as StorageVolumeObservation
      : null,
    lastMutationId: row.last_mutation_id,
    lastReason: row.last_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    terminalAt: row.terminal_at,
  };
}

export function releaseReservedStorageForTerminalOwner(input: {
  sqlite: Database.Database;
  ownerIds: string[];
  terminalLaneId: string;
  mutationIdPrefix: string;
  releasedAt?: number;
}): TerminalOwnerStorageReleaseResult {
  const ownerIds = [...new Set(input.ownerIds.map((ownerId) => ownerId.trim()).filter(Boolean))];
  if (ownerIds.length === 0) throw new Error('ownerIds must include at least one owner.');
  const terminalLaneId = requiredText(input.terminalLaneId, 'terminalLaneId');
  const mutationIdPrefix = requiredText(input.mutationIdPrefix, 'mutationIdPrefix');
  const releasedAt = input.releasedAt ?? Date.now();
  if (!Number.isSafeInteger(releasedAt) || releasedAt <= 0) {
    throw new Error('releasedAt must be a positive safe integer.');
  }
  const execute = input.sqlite.transaction(() => {
    const rows: ReservationRow[] = [];
    for (const ownerId of ownerIds) {
      const liveLanes = input.sqlite.prepare(`
        SELECT COUNT(*) FROM lanes
        WHERE packet_id = ? AND id != ? AND status NOT IN ('failed', 'completed', 'archived')
      `).pluck().get(ownerId, terminalLaneId) as number;
      if (liveLanes > 0) continue;
      rows.push(...input.sqlite.prepare(`
        SELECT * FROM storage_admission_reservations
        WHERE owner_id = ? AND state = 'reserved'
        ORDER BY owner_generation ASC, reservation_id ASC
      `).all(ownerId) as ReservationRow[]);
    }
    let releasedBytes = 0;
    for (const row of rows) {
      const ownerId = row.owner_id;
      const mutationId = `${mutationIdPrefix}:${row.reservation_id}:${row.generation}`;
      const request = {
        operation: 'release', mutationId, reservationId: row.reservation_id,
        volumeId: row.volume_id, ownerId, ownerGeneration: row.owner_generation,
        expectedGeneration: row.generation, terminalLaneId,
        terminalOwner: true,
      };
      const updated = input.sqlite.prepare(`
        UPDATE storage_admission_reservations
        SET state = 'released', generation = generation + 1,
            last_mutation_id = ?, last_reason = 'released', updated_at = ?, terminal_at = ?
        WHERE reservation_id = ? AND state = 'reserved' AND generation = ? AND owner_id = ?
      `).run(mutationId, releasedAt, releasedAt, row.reservation_id, row.generation, ownerId);
      if (updated.changes !== 1) {
        throw new Error('Storage reservation changed during terminal owner release.');
      }
      const current = input.sqlite.prepare(
        'SELECT * FROM storage_admission_reservations WHERE reservation_id = ?',
      ).get(row.reservation_id) as ReservationRow;
      const result: Omit<StorageAdmissionResult, 'idempotent'> = {
        operation: 'release', decision: 'released', reason: 'released', mutationId,
        reservation: mapReservation(current), observation: null, requiredReserveBytes: null,
        activeReservedBytes: null, headroomBytes: null, observedAvailableDeltaBytes: null,
        recordedAt: releasedAt,
      };
      const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
      input.sqlite.prepare(`
        INSERT INTO storage_admission_mutations (
          mutation_id, operation, request_hash, reservation_id, volume_id, result_json, recorded_at
        ) VALUES (?, 'release', ?, ?, ?, ?, ?)
      `).run(mutationId, requestHash, row.reservation_id, row.volume_id, JSON.stringify(result), releasedAt);
      releasedBytes += row.exact_bytes;
    }
    return { released: rows.length, releasedBytes };
  });
  return execute.immediate();
}
