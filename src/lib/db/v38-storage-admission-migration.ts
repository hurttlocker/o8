import type Database from 'better-sqlite3';

/** Schema v38: durable, volume-scoped storage admission reservations. */
export function ensureV38StorageAdmissionSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS storage_admission_reservations (
      reservation_id TEXT PRIMARY KEY,
      volume_id TEXT NOT NULL,
      target_path TEXT NOT NULL,
      root_identity_json TEXT,
      exact_bytes INTEGER NOT NULL CHECK (exact_bytes > 0),
      owner_id TEXT NOT NULL,
      owner_generation INTEGER NOT NULL CHECK (owner_generation > 0),
      generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
      state TEXT NOT NULL DEFAULT 'reserved'
        CHECK (state IN ('reserved', 'committed', 'released', 'reconciled')),
      lease_expires_at INTEGER NOT NULL,
      pre_measurement_json TEXT NOT NULL,
      post_measurement_json TEXT,
      last_mutation_id TEXT NOT NULL,
      last_reason TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      terminal_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_storage_admission_volume_state
      ON storage_admission_reservations(volume_id, state, lease_expires_at);
    CREATE INDEX IF NOT EXISTS idx_storage_admission_owner
      ON storage_admission_reservations(owner_id, owner_generation, state);

    CREATE TABLE IF NOT EXISTS storage_admission_mutations (
      mutation_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL
        CHECK (operation IN ('reserve', 'commit', 'release', 'reconcile')),
      request_hash TEXT NOT NULL,
      reservation_id TEXT,
      volume_id TEXT,
      result_json TEXT NOT NULL,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_storage_admission_mutation_reservation
      ON storage_admission_mutations(reservation_id, recorded_at);

    CREATE TRIGGER IF NOT EXISTS storage_admission_mutations_no_update
    BEFORE UPDATE ON storage_admission_mutations
    BEGIN
      SELECT RAISE(ABORT, 'storage admission mutation receipts are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS storage_admission_mutations_no_delete
    BEFORE DELETE ON storage_admission_mutations
    BEGIN
      SELECT RAISE(ABORT, 'storage admission mutation receipts are append-only');
    END;
  `);
}
