import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { ensureV43ResourceLeaseSchema } from './v43-resource-leases-migration';
import { ensureWorkerTokenStorage } from './worker-token-migration';

const openDatabases: Database.Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('v43 resource lease migration coexistence', () => {
  it('keeps the previous app worker-token write shape valid after the additive upgrade', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);
    sqlite.exec(`
      CREATE TABLE worker_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        packet_id TEXT,
        label TEXT,
        scope TEXT NOT NULL,
        max_workers INTEGER NOT NULL DEFAULT 10,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      )
    `);
    const legacyInsert = sqlite.prepare(`
      INSERT INTO worker_tokens
        (id, token_hash, packet_id, label, scope, max_workers, created_at, revoked_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, NULL)
    `);
    const legacySelect = sqlite.prepare(`
      SELECT id, token_hash, packet_id, revoked_at
      FROM worker_tokens
      WHERE token_hash = ? AND scope = ?
      LIMIT 1
    `);

    ensureWorkerTokenStorage(sqlite);
    ensureV43ResourceLeaseSchema(sqlite);
    legacyInsert.run(
      'legacy-token',
      'a'.repeat(64),
      'legacy-packet',
      'Legacy packet',
      'local-packet',
      new Date().toISOString(),
    );

    expect(legacySelect.get('a'.repeat(64), 'local-packet')).toMatchObject({
      id: 'legacy-token',
      packet_id: 'legacy-packet',
      revoked_at: null,
    });
    expect(sqlite.prepare(`
      SELECT lease_process_marker, lease_process_pid, lease_process_group_id
      FROM worker_tokens WHERE id = 'legacy-token'
    `).get()).toEqual({
      lease_process_marker: null,
      lease_process_pid: null,
      lease_process_group_id: null,
    });
  });

  it('upgrades an already-created pre-claim v43 schema without rewriting live rows', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);
    sqlite.exec(`
      CREATE TABLE resource_leases (
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
      CREATE TABLE resource_lease_waiters (
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
      INSERT INTO resource_leases VALUES (
        'legacy-resource', 'legacy-lease', 'legacy-owner', 'legacy-owner', 101,
        '{"version":1}', 1000, 60000, 1000
      );
    `);

    ensureV43ResourceLeaseSchema(sqlite);

    expect(sqlite.prepare(`
      SELECT resource, claim_token_hash FROM resource_leases
      WHERE resource = 'legacy-resource'
    `).get()).toEqual({ resource: 'legacy-resource', claim_token_hash: null });
    expect((sqlite.pragma('table_info(resource_lease_waiters)') as Array<{ name: string }>).map((column) => column.name))
      .toEqual(expect.arrayContaining(['actor', 'claim_token_hash']));
  });
});
