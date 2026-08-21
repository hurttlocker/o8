import { index, text, sqliteTable } from 'drizzle-orm/sqlite-core';

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
