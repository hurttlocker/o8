import type Database from 'better-sqlite3';

/** Schema v43: durable named resource holders, FIFO waiters, and append-only events. */
export function ensureV43ResourceLeaseSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS resource_leases (
      resource TEXT PRIMARY KEY,
      lease_id TEXT NOT NULL UNIQUE,
      owner_id TEXT NOT NULL,
      owner_label TEXT NOT NULL,
      owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
      owner_identity_json TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      ttl_ms INTEGER NOT NULL CHECK (ttl_ms > 0),
      heartbeat_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_lease_waiters (
      queue_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      waiter_id TEXT NOT NULL UNIQUE,
      resource TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      owner_label TEXT NOT NULL,
      owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
      owner_identity_json TEXT NOT NULL,
      waiter_pid INTEGER NOT NULL CHECK (waiter_pid > 0),
      waiter_identity_json TEXT NOT NULL,
      ttl_ms INTEGER NOT NULL CHECK (ttl_ms > 0),
      enqueued_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      UNIQUE(resource, owner_id, owner_pid, owner_identity_json)
    );

    CREATE INDEX IF NOT EXISTS idx_resource_lease_waiters_fifo
      ON resource_lease_waiters(resource, queue_sequence);

    CREATE TABLE IF NOT EXISTS resource_lease_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      resource TEXT NOT NULL,
      verb TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      timestamp TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_resource_lease_events_resource_sequence
      ON resource_lease_events(resource, sequence);
    CREATE INDEX IF NOT EXISTS idx_resource_lease_events_timestamp
      ON resource_lease_events(timestamp);

    CREATE TRIGGER IF NOT EXISTS resource_lease_events_no_update
    BEFORE UPDATE ON resource_lease_events
    BEGIN
      SELECT RAISE(ABORT, 'resource lease events are immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS resource_lease_events_no_delete
    BEFORE DELETE ON resource_lease_events
    BEGIN
      SELECT RAISE(ABORT, 'resource lease events are append-only');
    END;
  `);
}
