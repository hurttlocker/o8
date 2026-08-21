import { createHash } from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SpectatorTokenStore } from './spectator-token-store';

const openDatabases: Database.Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('SpectatorTokenStore', () => {
  it('persists only a hash and removes revoked credentials from middleware projection', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);
    const projected = new Set<string>();
    const projection = vi.fn<(hashes: string[]) => void>((hashes) => {
      projected.clear();
      for (const hash of hashes) projected.add(hash);
    });
    const store = new SpectatorTokenStore(sqlite, projection, () => projected);

    const minted = store.mint(' OBS source ');
    const expectedHash = createHash('sha256').update(minted.bearer).digest('hex');
    expect(minted).toMatchObject({
      record: { label: 'OBS source', revokedAt: null },
      bearer: expect.stringMatching(/^o8sp_/),
    });
    expect(sqlite.prepare('SELECT token_hash, label FROM broadcast_tokens').get()).toEqual({
      token_hash: expectedHash,
      label: 'OBS source',
    });
    expect(JSON.stringify(sqlite.prepare('SELECT * FROM broadcast_tokens').get())).not.toContain(minted.bearer);
    expect(projection).toHaveBeenLastCalledWith([expectedHash]);

    const revoked = store.revoke(minted.record.id);
    expect(revoked?.revokedAt).toEqual(expect.any(String));
    expect(projection).toHaveBeenLastCalledWith([]);
    expect(store.revoke(minted.record.id)).toBeNull();
  });

  it('does not resurrect authority removed during an interrupted revoke', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);
    const projected = new Set<string>();
    const store = new SpectatorTokenStore(sqlite, (hashes) => {
      projected.clear();
      for (const hash of hashes) projected.add(hash);
    }, () => projected);

    const first = store.mint('first');
    const firstHash = createHash('sha256').update(first.bearer).digest('hex');
    expect(projected).toContain(firstHash);

    // Simulate a crash after revoke published its fail-closed projection but
    // before SQLite recorded revoked_at.
    projected.delete(firstHash);
    const second = store.mint('second');
    const secondHash = createHash('sha256').update(second.bearer).digest('hex');

    expect(projected).toEqual(new Set([secondHash]));
    expect(sqlite.prepare('SELECT revoked_at FROM broadcast_tokens WHERE id = ?').get(first.record.id))
      .toEqual({ revoked_at: null });
  });

  it('rolls the canonical mutation back when its middleware projection cannot be written', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);
    const store = new SpectatorTokenStore(sqlite, () => {
      throw new Error('projection unavailable');
    });

    expect(() => store.mint()).toThrow(/projection unavailable/);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM broadcast_tokens').get()).toEqual({ count: 0 });
  });
});
