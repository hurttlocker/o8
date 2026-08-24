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

interface LaneEventPayloadRow {
  payload_json: string;
}

interface ReservationOwnerRow {
  reservation_id: string;
  owner_generation: number;
}

export interface TerminalOwnerStorageReleaseResult {
  released: number;
  releasedBytes: number;
  retainedUnprovableOwnerIds: string[];
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

/**
 * Return the highest reservation generation this lane recorded for one exact
 * owner. The reservation row binds the event to the owner, so stale events from
 * a packet that previously used the same lane cannot widen another packet's
 * release scope. Taking the maximum is order-independent when millisecond event
 * timestamps tie.
 */
export function laneStorageOwnerGeneration(
  sqlite: Database.Database,
  laneId: string,
  ownerId: string,
): number | undefined {
  const normalizedOwnerId = requiredText(ownerId, 'ownerId');
  const events = sqlite.prepare(`
    SELECT payload_json FROM lane_events
    WHERE lane_id = ? AND verb = 'update'
  `).all(laneId) as LaneEventPayloadRow[];
  const ownerGenerations = new Map((sqlite.prepare(`
    SELECT reservation_id, owner_generation FROM storage_admission_reservations
    WHERE owner_id = ?
  `).all(normalizedOwnerId) as ReservationOwnerRow[]).map((row) => (
    [row.reservation_id, row.owner_generation]
  )));
  let generation: number | undefined;
  for (const event of events) {
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>;
    const candidate = payload.storageAdmissionOwnerGeneration;
    const reservationId = payload.storageAdmissionReservationId;
    if (!Number.isSafeInteger(candidate) || Number(candidate) <= 0
      || typeof reservationId !== 'string' || !reservationId.trim()) continue;
    const value = Number(candidate);
    if (ownerGenerations.get(reservationId) !== value) continue;
    if (generation === undefined || value > generation) generation = value;
  }
  return generation;
}

/**
 * Lanes other than `excludeLaneId` that still name `ownerId` as their packet and
 * have not gone lane-terminal. While one exists the packet association survives,
 * so the packet's reservations stay reachable even if this lane drops them.
 */
function laneIdsStillNamingOwner(
  sqlite: Database.Database,
  ownerId: string,
  excludeLaneId: string,
): string[] {
  return sqlite.prepare(`
    SELECT id FROM lanes
    WHERE packet_id = ? AND id != ? AND status NOT IN ('failed', 'completed', 'archived')
  `).pluck().all(ownerId, excludeLaneId) as string[];
}

export function releaseReservedStorageForTerminalOwner(input: {
  sqlite: Database.Database;
  ownerIds: string[];
  ownerGeneration?: number;
  terminalLaneId: string;
  mutationIdPrefix: string;
  unprovableScopePolicy?: 'throw' | 'retain';
  releasedAt?: number;
}): TerminalOwnerStorageReleaseResult {
  const ownerIds = [...new Set(input.ownerIds.map((ownerId) => ownerId.trim()).filter(Boolean))];
  if (ownerIds.length === 0) throw new Error('ownerIds must include at least one owner.');
  const ownerGeneration = input.ownerGeneration;
  if (ownerGeneration !== undefined
    && (!Number.isSafeInteger(ownerGeneration) || ownerGeneration <= 0)) {
    throw new Error('ownerGeneration must be a positive safe integer.');
  }
  const terminalLaneId = requiredText(input.terminalLaneId, 'terminalLaneId');
  const mutationIdPrefix = requiredText(input.mutationIdPrefix, 'mutationIdPrefix');
  const releasedAt = input.releasedAt ?? Date.now();
  if (!Number.isSafeInteger(releasedAt) || releasedAt <= 0) {
    throw new Error('releasedAt must be a positive safe integer.');
  }
  const settle = (): TerminalOwnerStorageReleaseResult => {
    const rows: ReservationRow[] = [];
    const retainedUnprovableOwnerIds: string[] = [];
    for (const ownerId of ownerIds) {
      const ownerRows = input.sqlite.prepare(`
        SELECT * FROM storage_admission_reservations
        WHERE owner_id = ? AND state = 'reserved'
        ORDER BY owner_generation ASC, reservation_id ASC
      `).all(ownerId) as ReservationRow[];
      if (ownerRows.length === 0) continue;
      if (ownerId === terminalLaneId) {
        rows.push(...ownerRows);
        continue;
      }
      const liveLaneIds = laneIdsStillNamingOwner(input.sqlite, ownerId, terminalLaneId);
      if (ownerGeneration === undefined) {
        if (liveLaneIds.length > 0) continue;
        if (input.unprovableScopePolicy === 'retain') {
          retainedUnprovableOwnerIds.push(ownerId);
          continue;
        }
        throw new Error(
          `Storage release scope is unprovable for owner ${ownerId}: reserved rows exist, `
          + `lane ${terminalLaneId} records no matching owner generation, and no live sibling lane `
          + 'preserves the packet association.',
        );
      }
      const liveGenerations = liveLaneIds.map((laneId) => (
        laneStorageOwnerGeneration(input.sqlite, laneId, ownerId)
      ));
      if (liveGenerations.some((generation) => generation === undefined)) continue;
      if (liveLaneIds.length === 0
        && ownerRows.some((row) => row.owner_generation > ownerGeneration)) {
        if (input.unprovableScopePolicy === 'retain') {
          retainedUnprovableOwnerIds.push(ownerId);
          continue;
        }
        throw new Error(
          `Storage release scope is unprovable for owner ${ownerId}: lane ${terminalLaneId} `
          + `proves generation ${ownerGeneration}, but a newer reserved generation would lose `
          + 'the packet association.',
        );
      }
      const protectedGenerations = new Set(liveGenerations as number[]);
      rows.push(...ownerRows.filter((row) => (
        row.owner_generation <= ownerGeneration
        && !protectedGenerations.has(row.owner_generation)
      )));
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
    return { released: rows.length, releasedBytes, retainedUnprovableOwnerIds };
  };
  // Settlement must be able to join a caller's open transaction. When the lane
  // write that loses the packet association is already mid-transaction, running
  // the body directly makes release and association loss commit or roll back as
  // one unit — a nested BEGIN IMMEDIATE cannot. Standalone callers still get
  // their own immediate transaction.
  if (input.sqlite.inTransaction) return settle();
  return input.sqlite.transaction(settle).immediate();
}
