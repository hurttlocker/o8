import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const explainerQueue = sqliteTable('explainer_queue', {
  id: text('id').primaryKey(),
  packetId: text('packet_id').notNull(),
  laneId: text('lane_id').notNull(),
  repoPath: text('repo_path').notNull(),
  payloadJson: text('payload_json').notNull(),
  status: text('status', { enum: ['pending', 'in_progress', 'completed', 'failed'] }).notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  contentionCount: integer('contention_count').notNull().default(0),
  lastError: text('last_error'),
  backend: text('backend'),
  queueWaitMs: integer('queue_wait_ms'),
  turnDurationMs: integer('turn_duration_ms'),
  approximateCost: real('approximate_cost'),
  outcome: text('outcome'),
  claimedAt: text('claimed_at'),
  claimOwner: text('claim_owner'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => ({
  statusIdx: index('idx_explainer_queue_status').on(table.status),
  packetStatusIdx: index('idx_explainer_queue_packet_status').on(table.packetId, table.status),
}));
