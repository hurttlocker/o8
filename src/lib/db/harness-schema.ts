import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const harnessFeatures = sqliteTable('harness_features', {
  id: text('id').primaryKey(),
  repoPath: text('repo_path').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  priority: integer('priority').notNull().default(100),
  status: text('status', { enum: ['failing', 'passing', 'blocked'] }).notNull().default('failing'),
  verificationCommandJson: text('verification_command_json'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  repoStatusPriorityIdx: index('idx_harness_features_repo_status_priority')
    .on(table.repoPath, table.status, table.priority, table.createdAt),
}));

export const harnessFeatureChecks = sqliteTable('harness_feature_checks', {
  id: text('id').primaryKey(),
  featureId: text('feature_id').notNull().references(() => harnessFeatures.id, { onDelete: 'cascade' }),
  status: text('status', { enum: ['passed', 'failed', 'skipped'] }).notNull(),
  evidence: text('evidence').notNull().default(''),
  commandJson: text('command_json'),
  exitCode: integer('exit_code'),
  modelId: text('model_id'),
  packetId: text('packet_id'),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  featureCreatedIdx: index('idx_harness_feature_checks_feature_created')
    .on(table.featureId, table.createdAt),
}));

export const harnessGroundings = sqliteTable('harness_groundings', {
  id: text('id').primaryKey(),
  repoPath: text('repo_path').notNull(),
  task: text('task').notNull(),
  featureId: text('feature_id').references(() => harnessFeatures.id, { onDelete: 'set null' }),
  packetId: text('packet_id'),
  artifactJson: text('artifact_json').notNull(),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  repoCreatedIdx: index('idx_harness_groundings_repo_created').on(table.repoPath, table.createdAt),
}));

export const harnessContracts = sqliteTable('harness_contracts', {
  id: text('id').primaryKey(),
  repoPath: text('repo_path').notNull(),
  featureId: text('feature_id').references(() => harnessFeatures.id, { onDelete: 'set null' }),
  groundingId: text('grounding_id').references(() => harnessGroundings.id, { onDelete: 'set null' }),
  generatorTerms: text('generator_terms').notNull(),
  evaluatorTerms: text('evaluator_terms').notNull(),
  acceptanceJson: text('acceptance_json').notNull().default('[]'),
  status: text('status', { enum: ['proposed', 'accepted', 'verified', 'failed', 'superseded'] }).notNull().default('proposed'),
  proposedBy: text('proposed_by'),
  acceptedBy: text('accepted_by'),
  createdAt: integer('created_at').notNull(),
  acceptedAt: integer('accepted_at'),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  repoCreatedIdx: index('idx_harness_contracts_repo_created').on(table.repoPath, table.createdAt),
}));

export const harnessSprints = sqliteTable('harness_sprints', {
  id: text('id').primaryKey(),
  repoPath: text('repo_path').notNull(),
  contractId: text('contract_id').notNull().references(() => harnessContracts.id, { onDelete: 'cascade' }),
  packetId: text('packet_id'),
  currentFeatureId: text('current_feature_id').references(() => harnessFeatures.id, { onDelete: 'set null' }),
  status: text('status', { enum: ['active', 'blocked', 'completed'] }).notNull().default('active'),
  tickCount: integer('tick_count').notNull().default(0),
  eventLogJson: text('event_log_json').notNull().default('[]'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  completedAt: integer('completed_at'),
}, (table) => ({
  repoStatusIdx: index('idx_harness_sprints_repo_status').on(table.repoPath, table.status, table.updatedAt),
}));

export const harnessComponents = sqliteTable('harness_components', {
  componentKey: text('component_key').notNull(),
  modelId: text('model_id').notNull(),
  lifecycle: text('lifecycle', { enum: ['retained', 'candidate', 'shadow_only', 'retired'] }).notNull().default('retained'),
  reason: text('reason').notNull().default(''),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.componentKey, table.modelId] }),
}));

export const harnessMeasurements = sqliteTable('harness_measurements', {
  id: text('id').primaryKey(),
  componentKey: text('component_key').notNull(),
  modelId: text('model_id').notNull(),
  baselineScore: real('baseline_score').notNull(),
  enabledScore: real('enabled_score').notNull(),
  lift: real('lift').notNull(),
  sampleCount: integer('sample_count').notNull(),
  evidenceJson: text('evidence_json').notNull().default('{}'),
  createdAt: integer('created_at').notNull(),
}, (table) => ({
  componentModelCreatedIdx: index('idx_harness_measurements_component_model_created')
    .on(table.componentKey, table.modelId, table.createdAt),
}));
