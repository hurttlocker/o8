import 'server-only';

import { getSqlite } from '@/lib/db';
import {
  getWorkspaceSnapshot,
  prepareWorkspaceSnapshotTruth,
} from './snapshot-state';
import type {
  BeginWorkspaceSnapshotGenerationInput,
  BeginWorkspaceSnapshotGenerationResult,
  WorkspaceSnapshotJson,
  WorkspaceSnapshotRecord,
} from './snapshot-state-types';

interface GenerationReceiptRow {
  transition_kind: string;
  from_state: string | null;
  to_state: string;
  prior_version: number;
  resulting_version: number;
  receipt_json: string | null;
  error_json: string | null;
  snapshot_fingerprint: string;
  snapshot_generation: number;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive safe integer.`);
  }
  return value;
}

function immutableTruth(record: WorkspaceSnapshotRecord) {
  return {
    repositoryUuid: record.repositoryUuid,
    packetId: record.packetId,
    missionId: record.missionId,
    laneId: record.laneId,
    originalPath: record.originalPath,
    branch: record.branch,
    baseCommit: record.baseCommit,
    headCommit: record.headCommit,
    treeSha: record.treeSha,
    recoveryRef: record.recoveryRef,
    diffFingerprint: record.diffFingerprint,
    dependencyRecipeKey: record.dependencyRecipeKey,
    sessionIdentities: record.sessionIdentities,
    reservation: record.reservation,
  };
}

/**
 * Atomically supersede one fully materialized snapshot generation.
 *
 * The current projection moves to the new truth, while the append-only
 * generation receipt preserves and links the prior fingerprint for audit.
 */
export function beginWorkspaceSnapshotGeneration(
  input: BeginWorkspaceSnapshotGenerationInput,
): BeginWorkspaceSnapshotGenerationResult {
  const expectedVersion = positiveInteger(input.expectedVersion, 'expectedVersion');
  const expectedGeneration = positiveInteger(input.expectedGeneration, 'expectedGeneration');
  if (input.expectedState !== 'materialized' && input.expectedState !== 'parked') {
    throw new Error('A new snapshot generation can start only from materialized or parked truth.');
  }
  const sqlite = getSqlite();
  const execute = sqlite.transaction((): BeginWorkspaceSnapshotGenerationResult => {
    const current = getWorkspaceSnapshot(input.repositoryUuid, input.packetId);
    if (!current) return { status: 'missing', record: null };
    const nextGeneration = expectedGeneration + 1;
    const preparedBase = prepareWorkspaceSnapshotTruth(input);
    const priorReceipt = sqlite.prepare(`
      SELECT transition_kind, from_state, to_state, prior_version, resulting_version,
             receipt_json, error_json, snapshot_fingerprint, snapshot_generation
      FROM workspace_snapshot_transitions
      WHERE repository_uuid = ? AND packet_id = ? AND transition_id = ?
    `).get(
      preparedBase.repositoryUuid,
      preparedBase.packetId,
      preparedBase.creationId,
    ) as GenerationReceiptRow | undefined;
    if (priorReceipt) {
      let priorAnchor: Record<string, unknown> = {};
      try {
        priorAnchor = JSON.parse(priorReceipt.receipt_json ?? '{}') as Record<string, unknown>;
      } catch {
        throw new Error('Generation receipt contains invalid JSON.');
      }
      const preparedReplay = prepareWorkspaceSnapshotTruth({
        ...input,
        receipt: {
          ...(input.receipt ?? {}),
          previousSnapshot: priorAnchor.previousSnapshot as WorkspaceSnapshotJson,
          previousSnapshotFingerprint: String(priorAnchor.previousSnapshotFingerprint ?? ''),
          previousSnapshotGeneration: expectedGeneration,
        },
      });
      const replayMatches = priorReceipt.transition_kind === 'created'
        && priorReceipt.from_state === input.expectedState
        && priorReceipt.to_state === 'materialized'
        && priorReceipt.prior_version === expectedVersion
        && priorReceipt.resulting_version === expectedVersion + 1
        && priorReceipt.receipt_json === preparedReplay.receiptJson
        && priorReceipt.error_json === null
        && priorReceipt.snapshot_fingerprint === preparedReplay.snapshotFingerprint
        && priorReceipt.snapshot_generation === nextGeneration;
      if (!replayMatches) throw new Error(`Generation id ${preparedReplay.creationId} was reused with different truth.`);
      return current.snapshotGeneration === nextGeneration
        ? { status: 'idempotent', record: current }
        : { status: 'conflict', record: current };
    }
    if (current.state !== input.expectedState
      || current.version !== expectedVersion
      || current.snapshotGeneration !== expectedGeneration) {
      return { status: 'conflict', record: current };
    }
    const prepared = prepareWorkspaceSnapshotTruth({
      ...input,
      receipt: {
        ...(input.receipt ?? {}),
        previousSnapshot: immutableTruth(current) as unknown as WorkspaceSnapshotJson,
        previousSnapshotFingerprint: current.snapshotFingerprint,
        previousSnapshotGeneration: expectedGeneration,
      },
    });
    if (prepared.recordedAt < current.updatedAt) {
      throw new Error('A generation receipt cannot precede the current snapshot update.');
    }

    const updated = sqlite.prepare(`
      UPDATE workspace_snapshots
      SET mission_id = ?, lane_id = ?, original_path = ?, branch = ?, base_commit = ?,
          head_commit = ?, tree_sha = ?, recovery_ref = ?, diff_fingerprint = ?,
          dependency_recipe_key = ?, session_identity_json = ?, reservation_json = ?,
          snapshot_fingerprint = ?, snapshot_generation = ?, state = 'materialized',
          record_version = record_version + 1, last_transition_id = ?,
          transition_started_at = ?, state_entered_at = ?, last_error_json = NULL,
          last_error_at = NULL, updated_at = ?
      WHERE repository_uuid = ? AND packet_id = ? AND state = ?
        AND record_version = ? AND snapshot_generation = ?
    `).run(
      prepared.missionId,
      prepared.laneId,
      prepared.originalPath,
      prepared.branch,
      prepared.baseCommit,
      prepared.headCommit,
      prepared.treeSha,
      prepared.recoveryRef,
      prepared.diffFingerprint,
      prepared.dependencyRecipeKey,
      prepared.sessionIdentityJson,
      prepared.reservationJson,
      prepared.snapshotFingerprint,
      nextGeneration,
      prepared.creationId,
      prepared.transitionStartedAt,
      prepared.recordedAt,
      prepared.recordedAt,
      prepared.repositoryUuid,
      prepared.packetId,
      input.expectedState,
      expectedVersion,
      expectedGeneration,
    );
    if (updated.changes !== 1) {
      const conflicted = getWorkspaceSnapshot(prepared.repositoryUuid, prepared.packetId);
      return conflicted
        ? { status: 'conflict', record: conflicted }
        : { status: 'missing', record: null };
    }
    sqlite.prepare(`
      INSERT INTO workspace_snapshot_transitions (
        repository_uuid, packet_id, transition_id, transition_kind, from_state,
        to_state, prior_version, resulting_version, transition_started_at,
        recorded_at, receipt_json, error_json, snapshot_fingerprint, snapshot_generation
      ) VALUES (?, ?, ?, 'created', ?, 'materialized', ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      prepared.repositoryUuid,
      prepared.packetId,
      prepared.creationId,
      input.expectedState,
      expectedVersion,
      expectedVersion + 1,
      prepared.transitionStartedAt,
      prepared.recordedAt,
      prepared.receiptJson,
      prepared.snapshotFingerprint,
      nextGeneration,
    );
    return {
      status: 'applied',
      record: getWorkspaceSnapshot(prepared.repositoryUuid, prepared.packetId)!,
    };
  });
  return execute.immediate();
}
