import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import type {
  MetadataLockProcessIdentity,
  MetadataLockProcessProbe,
} from '@/lib/worktree/metadata-lock-process-identity';
import { ResourceLeaseStore } from './resource-lease-service';
import type { ResourceLeaseParticipant } from './resource-lease-types';

function identity(startId: string): MetadataLockProcessIdentity {
  return { version: 1, platform: 'linux', bootId: 'test-boot', startId };
}

function participant(id: string, pid: number): ResourceLeaseParticipant {
  const processIdentity = identity(String(pid));
  return {
    owner: { id, label: id, pid, identity: processIdentity },
    waiterPid: pid,
    waiterIdentity: processIdentity,
    actor: `principal:${id}`,
    claimTokenHash: createHash('sha256').update(`claim:${id}`).digest('hex'),
  };
}

function fixture() {
  const sqlite = new Database(':memory:');
  let now = 1_700_000_000_000;
  let nextId = 0;
  const probes = new Map<number, MetadataLockProcessProbe>();
  const store = new ResourceLeaseStore(sqlite, {
    now: () => now,
    probe: async (pid) => probes.get(pid) ?? { state: 'absent' },
    eventId: () => `event-${++nextId}`,
    leaseId: () => `lease-${++nextId}`,
  });
  const setLive = (pid: number) => probes.set(pid, { state: 'live', identity: identity(String(pid)) });
  return {
    sqlite,
    store,
    setLive,
    setProbe: (pid: number, probe: MetadataLockProcessProbe) => probes.set(pid, probe),
    advance: (milliseconds: number) => { now += milliseconds; },
  };
}

const openDatabases: Database.Database[] = [];

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('resource lease store', () => {
  it('keeps an overdue holder when exact process death is unknown, then reaps only after proof', async () => {
    const f = fixture();
    openDatabases.push(f.sqlite);
    f.setLive(101);
    f.setLive(202);

    const first = await f.store.acquire({
      resource: 'test-suite:repo:full-serial',
      participant: participant('first', 101),
      ttlMs: 1_000,
    });
    expect(first.state).toBe('acquired');
    f.advance(2_000);
    f.setProbe(101, { state: 'unknown', detail: 'probe unavailable' });

    const refused = await f.store.acquire({
      resource: 'test-suite:repo:full-serial',
      participant: participant('second', 202),
      ttlMs: 1_000,
    });
    expect(refused).toMatchObject({
      state: 'refused',
      reason: 'identity_unknown',
      holder: { owner: { id: 'first', pid: 101 }, overdue: true },
      blocked: { code: 'holder_identity_unknown' },
    });
    expect(f.sqlite.prepare("SELECT COUNT(*) AS count FROM resource_lease_events WHERE verb = 'reaped'")
      .get()).toEqual({ count: 0 });

    f.setProbe(101, { state: 'absent' });
    const acquired = await f.store.acquire({
      resource: 'test-suite:repo:full-serial',
      participant: participant('second', 202),
      ttlMs: 1_000,
    });
    expect(acquired).toMatchObject({ state: 'acquired', lease: { owner: { id: 'second' } } });
    expect(f.sqlite.prepare('SELECT verb, actor FROM resource_lease_events ORDER BY sequence').all())
      .toEqual([
        { verb: 'acquired', actor: 'principal:first' },
        { verb: 'reaped', actor: 'system' },
        { verb: 'acquired', actor: 'principal:second' },
      ]);
  });

  it('promotes live waiters in durable FIFO order', async () => {
    const f = fixture();
    openDatabases.push(f.sqlite);
    for (const pid of [101, 202, 303]) f.setLive(pid);
    const resource = 'repo-tree:/tmp/example';
    await f.store.acquire({ resource, participant: participant('first', 101) });
    const second = await f.store.acquire({
      resource,
      participant: participant('second', 202),
      wait: true,
      waiterId: 'waiter-second',
    });
    const third = await f.store.acquire({
      resource,
      participant: participant('third', 303),
      wait: true,
      waiterId: 'waiter-third',
    });
    expect(second).toMatchObject({ state: 'queued', waiter: { position: 1 } });
    expect(third).toMatchObject({ state: 'queued', waiter: { position: 2 } });

    const firstRelease = await f.store.release({
      resource,
      participant: participant('first', 101),
    });
    expect(firstRelease).toMatchObject({
      released: true,
      nextHolder: { owner: { id: 'second' } },
    });
    expect(await f.store.status(resource)).toMatchObject({
      holder: { owner: { id: 'second' } },
      waiters: [{ owner: { id: 'third' }, position: 1 }],
    });

    const secondRelease = await f.store.release({
      resource,
      participant: participant('second', 202),
    });
    expect(secondRelease).toMatchObject({
      released: true,
      nextHolder: { owner: { id: 'third' } },
    });
    expect(f.sqlite.prepare('SELECT verb, actor FROM resource_lease_events ORDER BY sequence').all())
      .toEqual([
        { verb: 'acquired', actor: 'principal:first' },
        { verb: 'wait_enqueued', actor: 'principal:second' },
        { verb: 'wait_enqueued', actor: 'principal:third' },
        { verb: 'released', actor: 'principal:first' },
        { verb: 'acquired', actor: 'principal:second' },
        { verb: 'released', actor: 'principal:second' },
        { verb: 'acquired', actor: 'principal:third' },
      ]);
  });

  it('does not skip an unknown FIFO waiter and returns the current holder on owner conflict', async () => {
    const f = fixture();
    openDatabases.push(f.sqlite);
    for (const pid of [101, 202, 303]) f.setLive(pid);
    const resource = 'apfs-mounts:test-host';
    await f.store.acquire({ resource, participant: participant('first', 101) });
    await f.store.acquire({
      resource,
      participant: participant('second', 202),
      wait: true,
      waiterId: 'waiter-second',
    });
    await f.store.acquire({
      resource,
      participant: participant('third', 303),
      wait: true,
      waiterId: 'waiter-third',
    });
    f.setProbe(202, { state: 'unknown', detail: 'identity probe denied' });

    const conflict = await f.store.release({
      resource,
      participant: participant('third', 303),
    });
    expect(conflict).toMatchObject({
      released: false,
      refusal: { code: 'not_owner', holder: { owner: { id: 'first' } } },
    });
    const release = await f.store.release({
      resource,
      participant: participant('first', 101),
    });
    expect(release).toMatchObject({ released: true, nextHolder: null });
    expect(await f.store.status(resource)).toMatchObject({
      holder: null,
      waiters: [
        { owner: { id: 'second' }, position: 1 },
        { owner: { id: 'third' }, position: 2 },
      ],
      blocked: { code: 'waiter_identity_unknown' },
    });
  });

  it('keeps resource lease events immutable and append-only', async () => {
    const f = fixture();
    openDatabases.push(f.sqlite);
    f.setLive(101);
    await f.store.acquire({ resource: 'free-form', participant: participant('first', 101) });
    expect(() => f.sqlite.prepare("UPDATE resource_lease_events SET actor = 'changed'").run())
      .toThrow(/immutable/);
    expect(() => f.sqlite.prepare('DELETE FROM resource_lease_events').run())
      .toThrow(/append-only/);
  });

  it('rejects an unbounded waiter id before writing queue state', async () => {
    const f = fixture();
    openDatabases.push(f.sqlite);
    f.setLive(101);
    await expect(f.store.acquire({
      resource: 'bounded-waiter-id',
      participant: participant('first', 101),
      wait: true,
      waiterId: 'x'.repeat(513),
    })).rejects.toThrow(/must not exceed 512/);
    expect(f.sqlite.prepare('SELECT COUNT(*) AS count FROM resource_lease_waiters').get())
      .toEqual({ count: 0 });
  });

  it('heartbeats only the exact holder and extends informational expiry', async () => {
    const f = fixture();
    openDatabases.push(f.sqlite);
    f.setLive(101);
    f.setLive(202);
    await f.store.acquire({
      resource: 'heartbeat-owner',
      participant: participant('first', 101),
      ttlMs: 1_000,
    });
    f.advance(500);
    expect(await f.store.heartbeat({
      resource: 'heartbeat-owner',
      participant: participant('second', 202),
      ttlMs: 2_000,
    })).toBeNull();
    expect(await f.store.heartbeat({
      resource: 'heartbeat-owner',
      participant: participant('first', 101),
      ttlMs: 2_000,
    })).toMatchObject({
      heartbeatAt: new Date(1_700_000_000_500).toISOString(),
      expiresAt: new Date(1_700_000_002_500).toISOString(),
      overdue: false,
    });
  });

  it('requires the private claim even when public holder fields and process identity match', async () => {
    const f = fixture();
    openDatabases.push(f.sqlite);
    f.setLive(101);
    const holder = participant('first', 101);
    await f.store.acquire({ resource: 'private-claim', participant: holder });
    const forged = {
      ...holder,
      actor: 'principal:attacker',
      claimTokenHash: createHash('sha256').update('attacker-claim').digest('hex'),
    };

    expect(await f.store.heartbeat({
      resource: 'private-claim',
      participant: forged,
    })).toBeNull();
    expect(await f.store.release({
      resource: 'private-claim',
      participant: forged,
    })).toMatchObject({
      released: false,
      refusal: { code: 'claim_unproven' },
    });
    expect(f.sqlite.prepare(`
      SELECT verb, actor FROM resource_lease_events ORDER BY sequence
    `).all()).toEqual([{ verb: 'acquired', actor: 'principal:first' }]);
  });
});
