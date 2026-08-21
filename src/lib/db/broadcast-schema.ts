import { index, integer, text, sqliteTable } from 'drizzle-orm/sqlite-core';

/** Durable, revocable credentials for the read-only Broadcast surface. */
export const broadcastTokens = sqliteTable('broadcast_tokens', {
  id: text('id').primaryKey(),
  tokenHash: text('token_hash').notNull().unique(),
  label: text('label'),
  createdAt: text('created_at').notNull(),
  revokedAt: text('revoked_at'),
}, (table) => ({
  activeIdx: index('idx_broadcast_tokens_active').on(table.revokedAt, table.createdAt),
}));

/** Lane-less narration and conversation entries carried by the Broadcast feed. */
export const broadcastEvents = sqliteTable('broadcast_events', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  kind: text('kind', { enum: ['commentary', 'conversation', 'focus'] }).notNull(),
  actor: text('actor').notNull(),
  audience: text('audience'),
  text: text('text').notNull(),
  laneId: text('lane_id'),
  packetId: text('packet_id'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  kindCreatedIdx: index('idx_broadcast_events_kind_created')
    .on(table.kind, table.createdAt),
}));
