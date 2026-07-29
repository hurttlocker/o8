/**
 * MACHINE REGISTRY CONTRACT TEST — phase 1b HTTP behavior without env, DB, or
 * network. The production Postgres store and this in-memory store implement the
 * same atomic MachineStore seam; concurrent requests exercise the real Hono
 * handlers and prove the cap decision cannot be split from the insert.
 *
 * Run: npm run machines-test
 */
import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';

import { Hono } from 'hono';
import { SignJWT, importPKCS8 } from 'jose';

import {
  DEVICE_CAPS,
  registerMachineRoutes,
  type MachineAuthResult,
  type MachineDevice,
  type MachineRegistration,
  type MachineRegistrationResult,
  type MachineStore,
} from '../src/machines-core.js';

interface StoredMachine extends MachineDevice {
  accountId: string;
  disconnectedAt: string | null;
}

function publicDevice(row: StoredMachine): MachineDevice {
  return {
    machineId: row.machineId,
    installId: row.installId,
    name: row.name,
    platform: row.platform,
    appVersion: row.appVersion,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}

class MemoryMachineStore implements MachineStore {
  private readonly rows: StoredMachine[] = [];
  private transactionTail: Promise<void> = Promise.resolve();

  private async transaction<T>(run: () => T | Promise<T>): Promise<T> {
    const prior = this.transactionTail;
    let release = () => {};
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await run();
    } finally {
      release();
    }
  }

  async registerAtomically(input: MachineRegistration): Promise<MachineRegistrationResult> {
    return this.transaction(async () => {
      await Promise.resolve();
      const existing = this.rows.find(
        (row) => row.accountId === input.accountId && row.installId === input.installId,
      );
      const active = this.rows.filter(
        (row) => row.accountId === input.accountId && row.disconnectedAt === null,
      );
      if ((!existing || existing.disconnectedAt !== null) && active.length >= input.deviceCap) {
        return {
          ok: false,
          devices: active.map(publicDevice),
        };
      }

      if (existing) {
        existing.name = input.name;
        existing.platform = input.platform;
        existing.appVersion = input.appVersion;
        existing.lastSeenAt = input.now.toISOString();
        existing.disconnectedAt = null;
      } else {
        this.rows.push({
          machineId: input.machineId,
          accountId: input.accountId,
          installId: input.installId,
          name: input.name,
          platform: input.platform,
          appVersion: input.appVersion,
          createdAt: input.now.toISOString(),
          lastSeenAt: input.now.toISOString(),
          disconnectedAt: null,
        });
      }
      const devices = this.rows
        .filter((row) => row.accountId === input.accountId && row.disconnectedAt === null)
        .map(publicDevice);
      return {
        ok: true,
        machineId: existing?.machineId ?? input.machineId,
        devices,
      };
    });
  }

  async list(accountId: string): Promise<MachineDevice[]> {
    return this.rows
      .filter((row) => row.accountId === accountId && row.disconnectedAt === null)
      .map(publicDevice);
  }

  async disconnect(accountId: string, machineId: string, now: Date): Promise<void> {
    const row = this.rows.find(
      (candidate) => candidate.accountId === accountId && candidate.machineId === machineId,
    );
    if (row && row.disconnectedAt === null) row.disconnectedAt = now.toISOString();
  }

  async heartbeat(accountId: string, machineId: string, now: Date): Promise<boolean> {
    const row = this.rows.find(
      (candidate) => candidate.accountId === accountId
        && candidate.machineId === machineId
        && candidate.disconnectedAt === null,
    );
    if (!row) return false;
    row.lastSeenAt = now.toISOString();
    return true;
  }
}

interface Harness {
  app: Hono;
  store: MemoryMachineStore;
  setNow(value: string): void;
}

function auth(token: string | null): Promise<MachineAuthResult> {
  const identities: Record<string, MachineAuthResult> = {
    'free-a': { ok: true, principal: { accountId: 'account-a', plan: 'free' } },
    'free-b': { ok: true, principal: { accountId: 'account-b', plan: 'free' } },
    'pro-a': { ok: true, principal: { accountId: 'account-a', plan: 'pro' } },
    expired: { ok: false, status: 401, reason: 'unauthorized' },
    unlinked: { ok: false, status: 403, reason: 'account_link_required' },
  };
  return Promise.resolve(identities[token ?? ''] ?? {
    ok: false,
    status: 401,
    reason: 'unauthorized',
  });
}

function harness(): Harness {
  const app = new Hono();
  const store = new MemoryMachineStore();
  let now = '2026-07-29T12:00:00.000Z';
  let id = 0;
  registerMachineRoutes(app, {
    authenticate: auth,
    store,
    now: () => new Date(now),
    newMachineId: () => `machine_${++id}`,
  });
  return {
    app,
    store,
    setNow(value) {
      now = value;
    },
  };
}

async function request(
  app: Hono,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function register(
  app: Hono,
  token: string,
  installId: string,
  name = installId,
): Promise<Response> {
  return request(app, 'POST', '/machines/register', token, {
    installId,
    name,
    platform: 'darwin',
    appVersion: '0.1.631',
  });
}

async function json(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

async function main() {
  assert.deepEqual(DEVICE_CAPS, { free: 3, pro: 10, team: 25 });

  {
    const h = harness();
    const a = await register(h.app, 'free-a', 'install-a');
    const b = await register(h.app, 'free-b', 'install-b');
    const aMachine = (await json(a) as { machineId: string }).machineId;
    const bMachine = (await json(b) as { machineId: string }).machineId;

    const aList = await request(h.app, 'GET', '/machines', 'free-a');
    const bList = await request(h.app, 'GET', '/machines', 'free-b');
    assert.deepEqual((await json(aList) as MachineDevice[]).map((device) => device.machineId), [aMachine]);
    assert.deepEqual((await json(bList) as MachineDevice[]).map((device) => device.machineId), [bMachine]);

    assert.equal((await request(h.app, 'DELETE', `/machines/${bMachine}`, 'free-a')).status, 204);
    assert.equal((await request(h.app, 'POST', `/machines/${bMachine}/heartbeat`, 'free-a')).status, 404);
    assert.equal((await request(h.app, 'GET', '/machines', 'free-b')).status, 200);
    assert.equal((await json(await request(h.app, 'GET', '/machines', 'free-b')) as unknown[]).length, 1);
  }

  {
    const h = harness();
    const first = await register(h.app, 'free-a', 'same-install', 'Old name');
    h.setNow('2026-07-29T12:01:00.000Z');
    const second = await register(h.app, 'free-a', 'same-install', 'New name');
    const firstBody = await json(first) as { machineId: string };
    const secondBody = await json(second) as { machineId: string; devices: MachineDevice[] };
    assert.equal(secondBody.machineId, firstBody.machineId);
    assert.equal(secondBody.devices.length, 1);
    assert.equal(secondBody.devices[0]?.name, 'New name');
    assert.equal(secondBody.devices[0]?.lastSeenAt, '2026-07-29T12:01:00.000Z');
  }

  {
    const h = harness();
    await register(h.app, 'free-a', 'install-1');
    await register(h.app, 'free-a', 'install-2');
    const results = await Promise.all([
      register(h.app, 'free-a', 'install-3'),
      register(h.app, 'free-a', 'install-4'),
    ]);
    assert.deepEqual(results.map((response) => response.status).sort(), [200, 409]);

    const conflict = results.find((response) => response.status === 409);
    assert(conflict);
    const devices = await json(await request(h.app, 'GET', '/machines', 'free-a')) as MachineDevice[];
    assert.equal(devices.length, 3);
    assert.deepEqual(await json(conflict), {
      reason: 'device_cap',
      deviceCap: 3,
      devices,
    });
  }

  {
    const h = harness();
    assert.equal((await request(h.app, 'GET', '/machines', 'expired')).status, 401);
    assert.deepEqual(await json(await request(h.app, 'GET', '/machines', 'expired')), {
      error: 'unauthorized',
    });
    assert.equal((await request(h.app, 'GET', '/machines', 'unlinked')).status, 403);
    assert.deepEqual(await json(await request(h.app, 'GET', '/machines', 'unlinked')), {
      reason: 'account_link_required',
    });
  }

  {
    const h = harness();
    const registrations = await Promise.all([
      register(h.app, 'free-a', 'install-1'),
      register(h.app, 'free-a', 'install-2'),
      register(h.app, 'free-a', 'install-3'),
    ]);
    const removed = (await json(registrations[1]!) as { machineId: string }).machineId;
    assert.equal((await request(h.app, 'DELETE', `/machines/${removed}`, 'free-a')).status, 204);
    assert.equal((await json(await request(h.app, 'GET', '/machines', 'free-a')) as unknown[]).length, 2);
    assert.equal((await register(h.app, 'free-a', 'install-4')).status, 200);
    const active = await json(await request(h.app, 'GET', '/machines', 'free-a')) as MachineDevice[];
    assert.equal(active.length, 3);
    assert.equal(active.some((device) => device.machineId === removed), false);
  }

  {
    const h = harness();
    const registered = await register(h.app, 'free-a', 'heartbeat-install');
    const machineId = (await json(registered) as { machineId: string }).machineId;
    h.setNow('2026-07-29T12:03:00.000Z');
    const heartbeat = await request(
      h.app,
      'POST',
      `/machines/${machineId}/heartbeat`,
      'free-a',
      { lastSeenAt: '1999-01-01T00:00:00.000Z' },
    );
    assert.equal(heartbeat.status, 204);
    const listed = await json(await request(h.app, 'GET', '/machines', 'free-a')) as MachineDevice[];
    assert.equal(listed[0]?.lastSeenAt, '2026-07-29T12:03:00.000Z');
  }

  {
    const { privateKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    Object.assign(process.env, {
      STRIPE_SECRET_KEY: 'test',
      STRIPE_WEBHOOK_SECRET: 'test',
      STRIPE_PRICE_SOLO: 'test',
      STRIPE_PRICE_TEAM: 'test',
      LICENSE_PRIVATE_KEY: privatePem,
      DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
      ADMIN_TOKEN: 'test',
      CLERK_ISSUER: '',
    });
    const signingKey = await importPKCS8(privatePem, 'EdDSA');
    const expiredToken = await new SignJWT({ plan: 'free', iss: 'o8-license' })
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject('install:expired')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(signingKey);
    const { authenticateMachine } = await import('../src/machines.js');
    assert.deepEqual(await authenticateMachine(expiredToken), {
      ok: false,
      status: 401,
      reason: 'unauthorized',
    });
  }

  console.log('[machines-test] OK — machine registry HTTP contract verified');
}

main().catch((error) => {
  console.error('[machines-test] FAILED:', error);
  process.exit(1);
});
