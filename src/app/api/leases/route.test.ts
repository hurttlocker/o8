import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'o8-lease-route-'));
const operatorToken = 'lease-route-operator-token-0123456789';
const workerToken = 'lease-route-worker-token-0123456789';
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
writeFileSync(path.join(dataDir, 'ws-token'), `${operatorToken}\n`, 'utf8');
writeFileSync(path.join(dataDir, 'worker-token'), `${workerToken}\n`, 'utf8');

const route = await import('./route');
const { closeDb } = await import('@/lib/db');
const { registerPacketWorkerTokenHash } = await import('@/lib/auth/worker-token');
const {
  bindPacketWorkerTokenProcess,
  mintPacketWorkerToken,
} = await import('@/lib/auth/packet-worker-token');
const children: ChildProcess[] = [];

function request(token: string, body: Record<string, unknown>) {
  return new NextRequest('http://127.0.0.1:3001/api/leases', {
    method: 'POST',
    headers: {
      host: '127.0.0.1:3001',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function owner(id: string, pid = process.pid) {
  return { id, label: id, pid };
}

function liveChild(processMarker?: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: processMarker
      ? { ...process.env, O8_OWNED_RUN_MARKER: processMarker }
      : process.env,
    stdio: 'ignore',
  });
  children.push(child);
  return child;
}

afterAll(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('/api/leases', () => {
  it('returns a structured holder refusal and releases only the exact owner', async () => {
    const resource = 'test-suite:route:full-serial';
    const acquired = await route.POST(request(operatorToken, {
      action: 'acquire',
      resource,
      owner: owner('route-owner'),
      claimToken: 'route-owner-claim-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ttlMs: 60_000,
    }));
    expect(acquired.status).toBe(200);
    expect(await acquired.json()).toMatchObject({
      ok: true,
      result: { state: 'acquired', lease: { owner: { id: 'route-owner', pid: process.pid } } },
    });

    const contender = liveChild();
    expect(contender.pid).toBeTypeOf('number');
    const refused = await route.POST(request(operatorToken, {
      action: 'acquire',
      resource,
      owner: owner('route-contender', contender.pid!),
      claimToken: 'route-contender-claim-bbbbbbbbbbbbbbbbbbbbbbbb',
      ttlMs: 60_000,
    }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      ok: false,
      result: {
        state: 'refused',
        reason: 'held',
        holder: { owner: { id: 'route-owner', pid: process.pid } },
      },
    });

    const status = await route.GET(new NextRequest(
      `http://127.0.0.1:3001/api/leases?resource=${encodeURIComponent(resource)}`,
      { headers: { authorization: `Bearer ${operatorToken}` } },
    ));
    expect(await status.json()).toMatchObject({
      ok: true,
      lease: { holder: { owner: { id: 'route-owner' } }, waiters: [] },
    });

    const released = await route.POST(request(operatorToken, {
      action: 'release',
      resource,
      owner: owner('route-owner'),
      claimToken: 'route-owner-claim-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    }));
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ ok: true, result: { released: true } });
  });

  it('refuses worker access to governance-reserved resource namespaces', async () => {
    const marker = 'lease-worker-reserved';
    const authorized = liveChild(marker);
    expect(authorized.pid).toBeTypeOf('number');
    const packetToken = mintPacketWorkerToken('pkt-lease-reserved', { processMarker: marker });
    bindPacketWorkerTokenProcess(packetToken, {
      pid: authorized.pid!,
      processMarker: marker,
    });
    const foreign = liveChild();
    expect(foreign.pid).toBeTypeOf('number');
    for (const resource of [
      'repo-tree:/tmp/worker-route',
      'test-suite:/tmp/worker-route:full-serial',
      'apfs-mounts:worker-route',
    ]) {
      const acquired = await route.POST(request(packetToken, {
        action: 'acquire',
        resource,
        owner: owner('forged-operator-label', foreign.pid!),
        claimToken: 'worker-claim-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ttlMs: 60_000,
      }));
      expect(acquired.status).toBe(409);
      expect(await acquired.json()).toMatchObject({
        ok: false,
        result: {
          state: 'refused',
          reason: 'reserved_namespace',
        },
      });
      const status = await route.GET(new NextRequest(
        `http://127.0.0.1:3001/api/leases?resource=${encodeURIComponent(resource)}`,
        { headers: { authorization: `Bearer ${operatorToken}` } },
      ));
      expect(await status.json()).toMatchObject({ lease: { holder: null } });
    }
  });

  it('refuses worker mutation when the credential has no process binding', async () => {
    const packetToken = mintPacketWorkerToken('pkt-lease-unbound');
    const response = await route.POST(request(packetToken, {
      action: 'acquire',
      resource: 'free-form:unbound-worker',
      owner: owner('unbound-worker'),
      claimToken: 'unbound-worker-claim-hhhhhhhhhhhhhhhhhhhhhhhhhhhh',
      ttlMs: 60_000,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'worker_process_unbound' },
    });
  });

  it('binds a worker lease PID to the authenticated packet process', async () => {
    const marker = 'lease-worker-process-proof';
    const authorized = liveChild(marker);
    const foreign = liveChild();
    expect(authorized.pid).toBeTypeOf('number');
    expect(foreign.pid).toBeTypeOf('number');
    const packetToken = mintPacketWorkerToken('pkt-lease-process-proof', { processMarker: marker });
    bindPacketWorkerTokenProcess(packetToken, {
      pid: authorized.pid!,
      processMarker: marker,
    });
    const resource = 'free-form:worker-process-proof';
    const refused = await route.POST(request(packetToken, {
      action: 'acquire',
      resource,
      owner: owner('foreign-pid', foreign.pid!),
      claimToken: 'foreign-worker-claim-ffffffffffffffffffffffffffff',
      ttlMs: 60_000,
    }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      ok: false,
      error: { code: 'worker_process_unproven' },
    });

    const acquired = await route.POST(request(packetToken, {
      action: 'acquire',
      resource,
      owner: owner('forged-label', authorized.pid!),
      claimToken: 'proved-worker-claim-gggggggggggggggggggggggggggg',
      ttlMs: 60_000,
    }));
    expect(acquired.status).toBe(200);
    expect(await acquired.json()).toMatchObject({
      result: {
        state: 'acquired',
        lease: {
          owner: {
            id: 'packet:pkt-lease-process-proof',
            label: 'packet:pkt-lease-process-proof',
            pid: authorized.pid,
          },
        },
      },
    });
    const released = await route.POST(request(packetToken, {
      action: 'release',
      resource,
      owner: owner('anything', authorized.pid!),
      claimToken: 'proved-worker-claim-gggggggggggggggggggggggggggg',
    }));
    expect(released.status).toBe(200);
    const { getSqlite } = await import('@/lib/db');
    expect(getSqlite().prepare(`
      SELECT actor FROM resource_lease_events
      WHERE resource = ? AND verb = 'released'
    `).get(resource)).toEqual({ actor: 'packet:pkt-lease-process-proof' });
  });

  it('rejects a status-derived release claim and attributes ledger events to the principal', async () => {
    const resource = 'free-form:release-proof';
    const victim = liveChild();
    expect(victim.pid).toBeTypeOf('number');
    const acquired = await route.POST(request(operatorToken, {
      action: 'acquire',
      resource,
      owner: owner('victim-label', victim.pid!),
      claimToken: 'victim-claim-cccccccccccccccccccccccccccccccc',
      ttlMs: 60_000,
    }));
    expect(acquired.status).toBe(200);

    const status = await route.GET(new NextRequest(
      `http://127.0.0.1:3001/api/leases?resource=${encodeURIComponent(resource)}`,
      { headers: { authorization: `Bearer ${operatorToken}` } },
    ));
    const snapshot = await status.json() as { lease: { holder: { owner: ReturnType<typeof owner> } } };
    const forged = await route.POST(request(operatorToken, {
      action: 'release',
      resource,
      owner: snapshot.lease.holder.owner,
      claimToken: 'attacker-claim-dddddddddddddddddddddddddddddddd',
    }));
    expect(forged.status).toBe(409);
    expect(await forged.json()).toMatchObject({
      ok: false,
      result: { released: false, refusal: { code: 'claim_unproven' } },
    });

    const released = await route.POST(request(operatorToken, {
      action: 'release',
      resource,
      owner: owner('victim-label', victim.pid!),
      claimToken: 'victim-claim-cccccccccccccccccccccccccccccccc',
    }));
    expect(released.status).toBe(200);
    const { getSqlite } = await import('@/lib/db');
    expect(getSqlite().prepare(`
      SELECT verb, actor FROM resource_lease_events
      WHERE resource = ? AND verb IN ('acquired', 'released')
      ORDER BY sequence ASC
    `).all(resource)).toEqual([
      { verb: 'acquired', actor: 'operator' },
      { verb: 'released', actor: 'operator' },
    ]);
  });

  it('fails closed when no authenticated principal reaches the handler', async () => {
    const response = await route.GET(new NextRequest('http://127.0.0.1:3001/api/leases'));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'principal_forbidden' },
    });
  });

  it('rejects a packet-class hash with no active authoritative token row', async () => {
    const unresolvedToken = 'packet-worker-without-authoritative-row';
    registerPacketWorkerTokenHash(createHash('sha256').update(unresolvedToken).digest('hex'));
    const response = await route.GET(new NextRequest('http://127.0.0.1:3001/api/leases', {
      headers: { authorization: `Bearer ${unresolvedToken}` },
    }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'worker_credential_unresolved' },
    });
  });
});
