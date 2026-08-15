import { createHash } from 'node:crypto';

import type { WorkspaceSnapshotState } from './snapshot-state-types';

export interface WorkspaceSnapshotChainRow {
  repository_uuid: string;
  packet_id: string;
  snapshot_fingerprint: string;
  snapshot_generation: number;
  state: string;
  record_version: number;
  last_transition_id: string;
  transition_started_at: number;
  state_entered_at: number;
  last_error_json: string | null;
  last_error_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface WorkspaceSnapshotChainReceipt {
  transition_id: string;
  transition_kind: string;
  from_state: string | null;
  to_state: string;
  prior_version: number;
  resulting_version: number;
  transition_started_at: number;
  recorded_at: number;
  receipt_json: string | null;
  error_json: string | null;
  snapshot_fingerprint: string;
  snapshot_generation: number;
}

const TRANSITIONS: Record<WorkspaceSnapshotState, ReadonlySet<WorkspaceSnapshotState>> = {
  materialized: new Set(['parkable', 'retiring']),
  parkable: new Set(['materialized', 'hibernating']),
  hibernating: new Set(['materialized', 'parked']),
  parked: new Set(['restoring']),
  restoring: new Set(['materialized', 'parked']),
  retiring: new Set(['materialized', 'retired']),
  retired: new Set(),
};

function isState(value: string): value is WorkspaceSnapshotState {
  return Object.hasOwn(TRANSITIONS, value);
}

function errorRecordedAt(raw: string | null): number | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { recordedAt?: unknown };
    return Number.isSafeInteger(parsed.recordedAt) ? parsed.recordedAt as number : null;
  } catch {
    return null;
  }
}

function generationAnchorMatches(
  receipt: WorkspaceSnapshotChainReceipt,
  previousGeneration: number,
  previousFingerprint: string,
): boolean {
  if (!receipt.receipt_json) return false;
  try {
    const parsed = JSON.parse(receipt.receipt_json) as Record<string, unknown>;
    const previousSnapshot = parsed.previousSnapshot;
    return parsed.previousSnapshotGeneration === previousGeneration
      && parsed.previousSnapshotFingerprint === previousFingerprint
      && previousSnapshot !== null
      && typeof previousSnapshot === 'object'
      && createHash('sha256')
        .update(JSON.stringify(previousSnapshot))
        .digest('hex') === previousFingerprint;
  } catch {
    return false;
  }
}

export function verifyWorkspaceSnapshotReceiptChain(
  row: WorkspaceSnapshotChainRow,
  recomputedFingerprint: string,
  receipts: WorkspaceSnapshotChainReceipt[],
): void {
  const fail = (message: string): never => {
    throw new Error(`Workspace snapshot ${row.repository_uuid}/${row.packet_id} ${message}`);
  };
  const creation = receipts[0];
  if (!creation
    || creation.transition_kind !== 'created'
    || creation.snapshot_generation !== 1
    || creation.from_state !== null
    || creation.to_state !== 'materialized'
    || creation.prior_version !== 0
    || creation.resulting_version !== 1
    || creation.error_json !== null
    || creation.recorded_at !== row.created_at
    || (row.snapshot_generation === 1 && creation.snapshot_fingerprint !== recomputedFingerprint)) {
    fail('does not match its immutable creation receipt.');
  }

  let previousState: WorkspaceSnapshotState = 'materialized';
  let previousVersion = 1;
  let previousRecordedAt = creation.recorded_at;
  let stateEnteredAt = creation.recorded_at;
  let generation = 1;
  let fingerprint = creation.snapshot_fingerprint;
  for (let index = 1; index < receipts.length; index += 1) {
    const receipt = receipts[index]!;
    const fromState = receipt.from_state;
    const toState = receipt.to_state;
    if (!fromState
      || !isState(fromState)
      || !isState(toState)
      || fromState !== previousState
      || receipt.prior_version !== previousVersion
      || receipt.resulting_version !== previousVersion + 1
      || receipt.recorded_at < previousRecordedAt
      || receipt.recorded_at < receipt.transition_started_at) {
      fail('has a broken transition receipt chain.');
    }
    const validFromState = fromState as WorkspaceSnapshotState;
    const validToState = toState as WorkspaceSnapshotState;

    if (receipt.transition_kind === 'created') {
      if ((previousState !== 'materialized' && previousState !== 'parked')
        || validToState !== 'materialized'
        || receipt.snapshot_generation !== generation + 1
        || receipt.error_json !== null
        || !generationAnchorMatches(receipt, generation, fingerprint)) {
        fail('has an invalid generation supersession receipt.');
      }
      generation = receipt.snapshot_generation;
      fingerprint = receipt.snapshot_fingerprint;
      stateEnteredAt = receipt.recorded_at;
    } else if (receipt.transition_kind === 'transition') {
      if (receipt.snapshot_generation !== generation
        || receipt.snapshot_fingerprint !== fingerprint) {
        fail('has a transition bound to the wrong snapshot generation.');
      }
      const sameStateFailure = validFromState === validToState;
      if ((sameStateFailure && receipt.error_json === null)
        || (!sameStateFailure && !TRANSITIONS[validFromState].has(validToState))) {
        fail('has an invalid state transition receipt.');
      }
      if (!sameStateFailure) stateEnteredAt = receipt.recorded_at;
    } else {
      fail('contains an unknown receipt kind.');
    }
    previousState = validToState;
    previousVersion = receipt.resulting_version;
    previousRecordedAt = receipt.recorded_at;
  }

  const latest = receipts.at(-1)!;
  if (receipts.length !== row.record_version
    || row.state !== previousState
    || row.record_version !== previousVersion
    || row.snapshot_generation !== generation
    || row.snapshot_fingerprint !== fingerprint
    || recomputedFingerprint !== fingerprint
    || row.last_transition_id !== latest.transition_id
    || row.transition_started_at !== latest.transition_started_at
    || row.state_entered_at !== stateEnteredAt
    || row.updated_at !== latest.recorded_at
    || row.last_error_json !== latest.error_json
    || row.last_error_at !== errorRecordedAt(latest.error_json)) {
    fail('current state does not match its immutable transition receipts.');
  }
}
