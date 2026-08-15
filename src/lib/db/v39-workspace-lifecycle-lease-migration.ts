import type Database from 'better-sqlite3';

/** Schema v39: one crash-recoverable cross-process mutation owner per packet. */
export function ensureV39WorkspaceLifecycleLeaseSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS workspace_lifecycle_leases (
      packet_id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL UNIQUE,
      owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
      owner_identity_json TEXT NOT NULL,
      acquired_at INTEGER NOT NULL
    );
  `);
}
