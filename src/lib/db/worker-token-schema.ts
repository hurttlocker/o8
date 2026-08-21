import { integer, text } from 'drizzle-orm/sqlite-core';

export function workerTokenColumns() {
  return {
    id: text('id').primaryKey(),
    tokenHash: text('token_hash').notNull().unique(),
    packetId: text('packet_id'),
    label: text('label'),
    scope: text('scope').notNull(),
    maxWorkers: integer('max_workers').notNull().default(10),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at'),
    leaseProcessMarker: text('lease_process_marker'),
    leaseProcessPid: integer('lease_process_pid'),
    leaseProcessGroupId: integer('lease_process_group_id'),
  };
}
