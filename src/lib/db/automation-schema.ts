import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const automations = sqliteTable('automations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  owner: text('owner').notNull(),
  projectId: text('project_id'),
  repoPath: text('repo_path').notNull(),
  branch: text('branch').notNull().default('main'),
  runtime: text('runtime').notNull(),
  prompt: text('prompt').notNull(),
  triggerKind: text('trigger_kind', { enum: ['manual', 'cron'] }).notNull().default('manual'),
  cronExpr: text('cron_expr'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  nextRunAt: integer('next_run_at'),
  catchUpPolicy: text('catch_up_policy', {
    enum: ['latest', 'all', 'skip'],
  }).notNull().default('latest'),
  repoConcurrencyLimit: integer('repo_concurrency_limit').notNull().default(1),
  lastRunAt: integer('last_run_at'),
  lastRunStatus: text('last_run_status', {
    enum: ['idle', 'running', 'ok', 'error'],
  }).notNull().default('idle'),
  lastLaneId: text('last_lane_id'),
  lastErrorMessage: text('last_error_message'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  ownerCreatedIdx: index('idx_automations_owner_created').on(table.owner, table.createdAt),
  enabledNextRunIdx: index('idx_automations_enabled_next_run').on(table.enabled, table.nextRunAt),
}));

export const automationFires = sqliteTable('automation_fires', {
  id: text('id').primaryKey(),
  automationId: text('automation_id').notNull().references(() => automations.id, { onDelete: 'cascade' }),
  executionJobId: text('execution_job_id').notNull().unique(),
  source: text('source', { enum: ['scheduled', 'manual'] }).notNull(),
  slotMs: integer('slot_ms'),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  repoPath: text('repo_path').notNull(),
  repoConcurrencyLimit: integer('repo_concurrency_limit').notNull().default(1),
  status: text('status', {
    enum: ['pending', 'leased', 'retrying', 'recovered', 'succeeded', 'parked', 'cancelled'],
  }).notNull().default('pending'),
  scheduledAt: integer('scheduled_at').notNull(),
  persistedAt: integer('persisted_at').notNull(),
  laneId: text('lane_id'),
  missionId: text('mission_id'),
  resultNote: text('result_note'),
  completedAt: integer('completed_at'),
  scheduleDelayMs: integer('schedule_delay_ms'),
  queueDelayMs: integer('queue_delay_ms'),
  executionMs: integer('execution_ms'),
  concurrentCount: integer('concurrent_count'),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
}, (table) => ({
  historyIdx: index('idx_automation_fires_automation_history').on(table.automationId, table.scheduledAt),
}));
