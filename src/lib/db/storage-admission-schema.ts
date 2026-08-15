import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const STORAGE_RESERVATION_STATE_ENUM = [
  'reserved',
  'committed',
  'released',
  'reconciled',
] as const;

export const storageAdmissionReservations = sqliteTable('storage_admission_reservations', {
  reservationId: text('reservation_id').primaryKey(),
  volumeId: text('volume_id').notNull(),
  targetPath: text('target_path').notNull(),
  rootIdentityJson: text('root_identity_json'),
  exactBytes: integer('exact_bytes').notNull(),
  ownerId: text('owner_id').notNull(),
  ownerGeneration: integer('owner_generation').notNull(),
  generation: integer('generation').notNull().default(1),
  state: text('state', { enum: STORAGE_RESERVATION_STATE_ENUM }).notNull().default('reserved'),
  leaseExpiresAt: integer('lease_expires_at').notNull(),
  preMeasurementJson: text('pre_measurement_json').notNull(),
  postMeasurementJson: text('post_measurement_json'),
  lastMutationId: text('last_mutation_id').notNull(),
  lastReason: text('last_reason').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  terminalAt: integer('terminal_at'),
}, (table) => ({
  volumeStateIdx: index('idx_storage_admission_volume_state')
    .on(table.volumeId, table.state, table.leaseExpiresAt),
  ownerIdx: index('idx_storage_admission_owner')
    .on(table.ownerId, table.ownerGeneration, table.state),
}));

export const storageAdmissionMutations = sqliteTable('storage_admission_mutations', {
  mutationId: text('mutation_id').primaryKey(),
  operation: text('operation', { enum: ['reserve', 'commit', 'release', 'reconcile'] }).notNull(),
  requestHash: text('request_hash').notNull(),
  reservationId: text('reservation_id'),
  volumeId: text('volume_id'),
  resultJson: text('result_json').notNull(),
  recordedAt: integer('recorded_at').notNull(),
}, (table) => ({
  reservationIdx: index('idx_storage_admission_mutation_reservation')
    .on(table.reservationId, table.recordedAt),
}));
