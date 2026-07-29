import { generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';

import { Hono } from 'hono';

import {
  registerMachineRoutes,
  type MachineAuthResult,
  type MachineDevice,
  type MachineRegistrationResult,
  type MachineStore,
} from '../src/machines-core.js';
import {
  authorizeMachineHeartbeat,
  mintMachineRelayTicketWith,
  verifyMachineRelayTicketWith,
} from '../src/relay-ticket.js';

const ISSUER = 'o8-license';
const NOW = new Date('2026-07-29T16:00:00.000Z');

function device(machineId: string, installId: string): MachineDevice {
  return {
    machineId,
    installId,
    name: machineId,
    platform: 'darwin',
    appVersion: '0.1.632',
    createdAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
  };
}

class MemoryStore implements MachineStore {
  readonly active = new Map<string, MachineDevice[]>([
    ['account-a', [device('machine-a', 'install-a'), device('machine-tombstone', 'install-old')]],
    ['account-b', [device('machine-b', 'install-b')]],
  ]);

  async registerAtomically(): Promise<MachineRegistrationResult> {
    throw new Error('registration is outside this contract test');
  }

  async list(accountId: string): Promise<MachineDevice[]> {
    return [...(this.active.get(accountId) ?? [])];
  }

  async disconnect(accountId: string, machineId: string): Promise<void> {
    this.active.set(
      accountId,
      (this.active.get(accountId) ?? []).filter((candidate) => candidate.machineId !== machineId),
    );
  }

  async heartbeat(accountId: string, machineId: string, now: Date): Promise<boolean> {
    const candidate = (this.active.get(accountId) ?? [])
      .find((entry) => entry.machineId === machineId);
    if (!candidate) return false;
    candidate.lastSeenAt = now.toISOString();
    return true;
  }
}

function authenticate(token: string | null): Promise<MachineAuthResult> {
  if (token === 'account-a' || token === 'account-b') {
    return Promise.resolve({
      ok: true,
      principal: { accountId: token, plan: 'free' },
    });
  }
  return Promise.resolve({ ok: false, status: 401, reason: 'unauthorized' });
}

async function request(
  app: Hono,
  method: string,
  path: string,
  token: string,
): Promise<Response> {
  return app.request(`http://license.test${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
  });
}

async function main(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const store = new MemoryStore();
  const app = new Hono();

  const verifyTicket = (token: string, now = NOW) => verifyMachineRelayTicketWith(token, {
    publicKeyPem,
    issuer: ISSUER,
    now,
  });
  const mintTicket = (
    accountId: string,
    machine: MachineDevice,
    now = NOW,
  ) => mintMachineRelayTicketWith({
    accountId,
    machineId: machine.machineId,
    installId: machine.installId,
  }, {
    privateKeyPem,
    issuer: ISSUER,
    now,
  });

  registerMachineRoutes(app, {
    authenticate,
    store,
    now: () => NOW,
    newMachineId: () => 'unused',
    relayTickets: {
      mint: ({ accountId, machine, now }) => mintTicket(accountId, machine, now),
      authorizeHeartbeat: (token, machineId) => authorizeMachineHeartbeat({
        token,
        machineId,
        verifyTicket: (candidate) => verifyTicket(candidate),
        authenticateAccount: authenticate,
      }),
    },
  });

  console.log('\n[machine-relay contract-test] ticket issuance and heartbeat\n');

  const issued = await request(app, 'POST', '/machines/machine-a/relay-ticket', 'account-a');
  assert.equal(issued.status, 200);
  const issuedBody = await issued.json() as { ticket: string; expiresAt: string };
  assert.equal(issuedBody.expiresAt, '2026-07-29T16:10:00.000Z');
  const verified = await verifyTicket(issuedBody.ticket);
  assert.deepEqual(verified, {
    ok: true,
    claims: {
      accountId: 'account-a',
      machineId: 'machine-a',
      installId: 'install-a',
      exp: 1785341400,
    },
  });
  console.log('  PASS: an owner receives a signed 10-minute machine relay ticket');

  const otherAccount = await request(
    app,
    'POST',
    '/machines/machine-a/relay-ticket',
    'account-b',
  );
  assert.equal(otherAccount.status, 404);
  assert.deepEqual(await otherAccount.json(), { error: 'not_found' });
  console.log('  PASS: an account cannot mint a ticket for another account machine');

  await store.disconnect('account-a', 'machine-tombstone');
  const tombstoned = await request(
    app,
    'POST',
    '/machines/machine-tombstone/relay-ticket',
    'account-a',
  );
  assert.equal(tombstoned.status, 404);
  assert.deepEqual(await tombstoned.json(), { error: 'not_found' });
  console.log('  PASS: a tombstoned machine cannot receive a relay ticket');

  const heartbeat = await request(
    app,
    'POST',
    '/machines/machine-a/heartbeat',
    issuedBody.ticket,
  );
  assert.equal(heartbeat.status, 204);
  console.log('  PASS: a relay ticket authenticates the real heartbeat route');

  const mismatchedHeartbeat = await request(
    app,
    'POST',
    '/machines/machine-b/heartbeat',
    issuedBody.ticket,
  );
  assert.equal(mismatchedHeartbeat.status, 401);
  console.log('  PASS: the ticket machine claim must match the heartbeat path');

  const legacyHeartbeat = await request(
    app,
    'POST',
    '/machines/machine-a/heartbeat',
    'account-a',
  );
  assert.equal(legacyHeartbeat.status, 204);
  console.log('  PASS: the shipped account credential remains accepted for heartbeat');

  const expiredTicket = await mintTicket(
    'account-a',
    device('machine-a', 'install-a'),
    new Date('2026-07-29T15:49:00.000Z'),
  );
  const expiredHeartbeat = await request(
    app,
    'POST',
    '/machines/machine-a/heartbeat',
    expiredTicket.ticket,
  );
  assert.equal(expiredHeartbeat.status, 401);
  console.log('  PASS: an expired relay ticket cannot heartbeat');

  console.log('\n[machine-relay contract-test] OK\n');
}

main().catch((error) => {
  console.error('[machine-relay contract-test] ERROR:', error);
  process.exit(1);
});
