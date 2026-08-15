import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const WORKSPACE_SNAPSHOT_STATE_ENUM = [
  'materialized',
  'parkable',
  'hibernating',
  'parked',
  'restoring',
  'retiring',
  'retired',
] as const;

export const workspaceSnapshots = sqliteTable('workspace_snapshots', {
  repositoryUuid: text('repository_uuid').notNull(),
  packetId: text('packet_id').notNull(),
  missionId: text('mission_id'),
  laneId: text('lane_id'),
  originalPath: text('original_path').notNull(),
  branch: text('branch').notNull(),
  baseCommit: text('base_commit').notNull(),
  headCommit: text('head_commit').notNull(),
  treeSha: text('tree_sha').notNull(),
  recoveryRef: text('recovery_ref').notNull(),
  diffFingerprint: text('diff_fingerprint').notNull(),
  dependencyRecipeKey: text('dependency_recipe_key'),
  sessionIdentityJson: text('session_identity_json').notNull().default('[]'),
  reservationJson: text('reservation_json'),
  snapshotFingerprint: text('snapshot_fingerprint').notNull(),
  snapshotGeneration: integer('snapshot_generation').notNull().default(1),
  state: text('state', { enum: WORKSPACE_SNAPSHOT_STATE_ENUM }).notNull().default('materialized'),
  recordVersion: integer('record_version').notNull().default(1),
  lastTransitionId: text('last_transition_id').notNull(),
  transitionStartedAt: integer('transition_started_at').notNull(),
  stateEnteredAt: integer('state_entered_at').notNull(),
  lastErrorJson: text('last_error_json'),
  lastErrorAt: integer('last_error_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.repositoryUuid, table.packetId] }),
  stateUpdatedIdx: index('idx_workspace_snapshots_state_updated').on(table.state, table.updatedAt),
  missionIdx: index('idx_workspace_snapshots_mission').on(table.missionId, table.updatedAt),
  laneIdx: index('idx_workspace_snapshots_lane').on(table.laneId, table.updatedAt),
}));

export const workspaceSnapshotTransitions = sqliteTable('workspace_snapshot_transitions', {
  repositoryUuid: text('repository_uuid').notNull(),
  packetId: text('packet_id').notNull(),
  transitionId: text('transition_id').notNull(),
  transitionKind: text('transition_kind', { enum: ['created', 'transition'] }).notNull().default('transition'),
  fromState: text('from_state', { enum: WORKSPACE_SNAPSHOT_STATE_ENUM }),
  toState: text('to_state', { enum: WORKSPACE_SNAPSHOT_STATE_ENUM }).notNull(),
  priorVersion: integer('prior_version').notNull(),
  resultingVersion: integer('resulting_version').notNull(),
  transitionStartedAt: integer('transition_started_at').notNull(),
  recordedAt: integer('recorded_at').notNull(),
  receiptJson: text('receipt_json'),
  errorJson: text('error_json'),
  snapshotFingerprint: text('snapshot_fingerprint').notNull(),
  snapshotGeneration: integer('snapshot_generation').notNull().default(1),
}, (table) => ({
  pk: primaryKey({ columns: [table.repositoryUuid, table.packetId, table.transitionId] }),
  packetRecordedIdx: index('idx_workspace_snapshot_transitions_packet_recorded')
    .on(table.repositoryUuid, table.packetId, table.recordedAt),
}));
