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

function liveChild(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
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
    }));
    expect(released.status).toBe(200);
    expect(await released.json()).toMatchObject({ ok: true, result: { released: true } });
  });

  it('binds a worker lease owner to the authenticated packet authority class', async () => {
    const resource = 'repo-tree:/tmp/worker-route';
    const acquired = await route.POST(request(workerToken, {
      action: 'acquire',
      resource,
      owner: owner('forged-operator-label'),
      ttlMs: 60_000,
    }));
    expect(acquired.status).toBe(200);
    expect(await acquired.json()).toMatchObject({
      result: {
        state: 'acquired',
        lease: { owner: { id: 'worker:legacy', label: 'worker:legacy' } },
      },
    });
    const released = await route.POST(request(workerToken, {
      action: 'release',
      resource,
      owner: owner('anything'),
    }));
    expect(released.status).toBe(200);
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
