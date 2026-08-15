export const WORKSPACE_SNAPSHOT_STATES = [
  'materialized',
  'parkable',
  'hibernating',
  'parked',
  'restoring',
  'retiring',
  'retired',
] as const;

export type WorkspaceSnapshotState = typeof WORKSPACE_SNAPSHOT_STATES[number];

export type WorkspaceSnapshotJson =
  | string
  | number
  | boolean
  | null
  | WorkspaceSnapshotJson[]
  | { [key: string]: WorkspaceSnapshotJson };

export interface WorkspaceSessionIdentityReceipt {
  kind: string;
  identity: string;
  runtime?: string | null;
  bindingId?: string | null;
}

export interface WorkspaceReservationReceipt {
  id: string;
  bytes: number;
  volumeId?: string | null;
  reservedAt: number;
}

export interface WorkspaceSnapshotErrorReceipt {
  code: string;
  message: string;
  phase: string;
  recordedAt: number;
  details?: WorkspaceSnapshotJson;
}

export interface WorkspaceSnapshotRecord {
  repositoryUuid: string;
  packetId: string;
  missionId: string | null;
  laneId: string | null;
  originalPath: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
  diffFingerprint: string;
  dependencyRecipeKey: string | null;
  sessionIdentities: WorkspaceSessionIdentityReceipt[];
  reservation: WorkspaceReservationReceipt | null;
  snapshotFingerprint: string;
  snapshotGeneration: number;
  state: WorkspaceSnapshotState;
  version: number;
  lastTransitionId: string;
  transitionStartedAt: number;
  stateEnteredAt: number;
  lastError: WorkspaceSnapshotErrorReceipt | null;
  lastErrorAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceSnapshotTransitionReceipt {
  repositoryUuid: string;
  packetId: string;
  transitionId: string;
  kind: 'created' | 'transition';
  fromState: WorkspaceSnapshotState | null;
  toState: WorkspaceSnapshotState;
  priorVersion: number;
  resultingVersion: number;
  transitionStartedAt: number;
  recordedAt: number;
  receipt: Record<string, WorkspaceSnapshotJson> | null;
  error: WorkspaceSnapshotErrorReceipt | null;
  snapshotFingerprint: string;
  snapshotGeneration: number;
}

export interface WorkspaceSnapshotReconciliationScan {
  snapshots: WorkspaceSnapshotRecord[];
  corruptions: Array<{
    repositoryUuid: string;
    packetId: string;
    note: string;
  }>;
}

export interface CreateWorkspaceSnapshotInput {
  repositoryUuid: string;
  packetId: string;
  missionId?: string | null;
  laneId?: string | null;
  originalPath: string;
  branch: string;
  baseCommit: string;
  headCommit: string;
  treeSha: string;
  recoveryRef: string;
  diffFingerprint: string;
  dependencyRecipeKey?: string | null;
  sessionIdentities: WorkspaceSessionIdentityReceipt[];
  reservation?: WorkspaceReservationReceipt | null;
  creationId: string;
  transitionStartedAt?: number;
  recordedAt?: number;
  receipt?: Record<string, WorkspaceSnapshotJson> | null;
}

export interface TransitionWorkspaceSnapshotInput {
  repositoryUuid: string;
  packetId: string;
  transitionId: string;
  expectedState: WorkspaceSnapshotState;
  expectedVersion: number;
  expectedGeneration?: number;
  toState: WorkspaceSnapshotState;
  transitionStartedAt?: number;
  recordedAt?: number;
  receipt?: Record<string, WorkspaceSnapshotJson> | null;
  error?: WorkspaceSnapshotErrorReceipt | null;
}

export interface BeginWorkspaceSnapshotGenerationInput extends CreateWorkspaceSnapshotInput {
  expectedState: 'materialized' | 'parked';
  expectedVersion: number;
  expectedGeneration: number;
}

export type CreateWorkspaceSnapshotResult =
  | { status: 'created' | 'idempotent'; record: WorkspaceSnapshotRecord }
  | { status: 'conflict'; record: WorkspaceSnapshotRecord };

export type TransitionWorkspaceSnapshotResult =
  | { status: 'applied' | 'idempotent'; record: WorkspaceSnapshotRecord }
  | { status: 'conflict'; record: WorkspaceSnapshotRecord }
  | { status: 'missing'; record: null };

export type BeginWorkspaceSnapshotGenerationResult =
  | { status: 'applied' | 'idempotent'; record: WorkspaceSnapshotRecord }
  | { status: 'conflict'; record: WorkspaceSnapshotRecord }
  | { status: 'missing'; record: null };
