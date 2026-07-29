import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';

import { SignJWT, importPKCS8 } from 'jose';
import type { WebSocket } from 'ws';

import { createLicenseServerClient } from '../src/license-client.js';
import { verifyMachineRelayTicketWith } from '../src/machine-ticket.js';
import { RelayServer } from '../src/relay.js';

const ISSUER = 'o8-license';
const NOW_MS = Date.parse('2026-07-29T16:00:00.000Z');

class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: string[] = [];
  closed: { code: number; reason?: string } | null = null;

  send(data: string | Buffer): void {
    this.sent.push(Buffer.isBuffer(data) ? data.toString('utf8') : data);
  }

  close(code = 1000, reason?: string): void {
    this.readyState = 3;
    this.closed = { code, reason };
  }

  finish(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

function socket(value: FakeSocket): WebSocket {
  return value as unknown as WebSocket;
}

function request(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

async function mint(
  privateKeyPem: string,
  claims: { accountId: string; machineId: string; installId: string },
  options: { audience?: string; expiresInSeconds?: number } = {},
): Promise<string> {
  const key = await importPKCS8(privateKeyPem, 'EdDSA');
  const now = Math.floor(NOW_MS / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(ISSUER)
    .setAudience(options.audience ?? 'o8-relay')
    .setIssuedAt(now)
    .setExpirationTime(now + (options.expiresInSeconds ?? 600))
    .sign(key);
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function main(): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const heartbeatRequests: Array<{ path: string; authorization: string }> = [];
  let ownerAllowed = true;

  const licenseClient = createLicenseServerClient({
    baseUrl: 'https://license.test',
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get('authorization') ?? '';
      if (init?.method === 'GET' && url.pathname === '/machines') {
        const devices = authorization === 'Bearer web-account-a' && ownerAllowed
          ? [{ machineId: 'machine-a' }]
          : authorization === 'Bearer web-account-b'
            ? [{ machineId: 'machine-b' }]
            : [];
        return Response.json(devices);
      }
      if (init?.method === 'POST' && url.pathname === '/machines/machine-a/heartbeat') {
        heartbeatRequests.push({ path: url.pathname, authorization });
        return new Response(null, { status: 204 });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  });

  const relay = new RelayServer({
    now: () => NOW_MS,
    verifyMachineTicket: (token) => verifyMachineRelayTicketWith(token, {
      publicKeyPem,
      issuer: ISSUER,
      now: new Date(NOW_MS),
    }),
    authorizeWebMachine: licenseClient.authorizeWebMachine,
    heartbeatMachine: licenseClient.heartbeatMachine,
    machineHeartbeatMs: 60_000,
  });

  const validTicket = await mint(privateKeyPem, {
    accountId: 'account-a',
    machineId: 'machine-a',
    installId: 'install-a',
  });

  console.log('\n[relay machine contract-test] handshake, ownership, and heartbeat\n');

  const expired = new FakeSocket();
  await relay.onMachineConnected(socket(expired), request({
    authorization: `Bearer ${await mint(privateKeyPem, {
      accountId: 'account-a',
      machineId: 'machine-a',
      installId: 'install-a',
    }, { expiresInSeconds: -1 })}`,
    'x-o8-machine-id': 'machine-a',
  }));
  assert.equal(expired.closed?.reason, 'machine_ticket_expired');
  assert.equal(relay.stats().machines, 0);
  console.log('  PASS: an expired ticket is rejected by the real machine handshake');

  const wrongAudience = new FakeSocket();
  await relay.onMachineConnected(socket(wrongAudience), request({
    authorization: `Bearer ${await mint(privateKeyPem, {
      accountId: 'account-a',
      machineId: 'machine-a',
      installId: 'install-a',
    }, { audience: 'someone-else' })}`,
    'x-o8-machine-id': 'machine-a',
  }));
  assert.equal(wrongAudience.closed?.reason, 'machine_ticket_wrong_audience');
  assert.equal(relay.stats().machines, 0);
  console.log('  PASS: a wrong-audience ticket is rejected by the real machine handshake');

  const mismatch = new FakeSocket();
  await relay.onMachineConnected(socket(mismatch), request({
    authorization: `Bearer ${validTicket}`,
    'x-o8-machine-id': 'machine-b',
  }));
  assert.equal(mismatch.closed?.reason, 'machine_id_mismatch');
  assert.equal(relay.stats().machines, 0);
  console.log('  PASS: x-o8-machine-id must equal the signed machineId claim');

  const machine = new FakeSocket();
  await relay.onMachineConnected(socket(machine), request({
    authorization: `Bearer ${validTicket}`,
    'x-o8-machine-id': 'machine-a',
  }));
  await flush();
  assert.equal(machine.closed, null);
  assert.equal(relay.stats().machines, 1);
  assert.deepEqual(heartbeatRequests, [{
    path: '/machines/machine-a/heartbeat',
    authorization: `Bearer ${validTicket}`,
  }]);
  console.log('  PASS: an accepted machine is indexed and heartbeats with its relay ticket');

  const crossAccount = new FakeSocket();
  await relay.onWebMachineConnected(
    socket(crossAccount),
    'machine-a',
    request({ authorization: 'Bearer web-account-b' }),
  );
  assert.equal(crossAccount.closed?.reason, 'machine_not_owned');
  assert.equal(relay.stats().webMachineSessions, 0);
  console.log('  PASS: a web account cannot address another account machine');

  const owner = new FakeSocket();
  await relay.onWebMachineConnected(
    socket(owner),
    'machine-a',
    request({ authorization: 'Bearer web-account-a' }),
  );
  assert.equal(owner.closed, null);
  assert.equal(relay.stats().webMachineSessions, 1);
  assert.equal(machine.sent.some((frame) => frame.includes('"mux-open"')), true);
  console.log('  PASS: server-verified ownership admits the web machine session');

  owner.finish();
  assert.equal(
    machine.sent.some((frame) => frame.includes('"mux-close"')),
    true,
  );
  assert.equal(relay.stats().webMachineSessions, 0);
  console.log('  PASS: closing the web edge tears down its machine mux stream');

  const reconnect = new FakeSocket();
  await relay.onWebMachineConnected(
    socket(reconnect),
    'machine-a',
    request({ authorization: 'Bearer web-account-a' }),
  );
  assert.equal(reconnect.closed, null);
  assert.equal(relay.stats().webMachineSessions, 1);

  machine.finish();
  assert.deepEqual(reconnect.closed, { code: 1012, reason: 'machine_disconnected' });
  assert.equal(
    reconnect.sent.some((frame) => frame.includes('"machine":"down"')),
    true,
  );
  reconnect.finish();
  assert.equal(relay.stats().webMachineSessions, 0);
  console.log('  PASS: a machine drop closes every web stream after presence-down');

  ownerAllowed = false;
  const staleOwner = new FakeSocket();
  await relay.onWebMachineConnected(
    socket(staleOwner),
    'machine-a',
    request({ authorization: 'Bearer web-account-a' }),
  );
  assert.equal(staleOwner.closed?.reason, 'machine_not_owned');
  assert.equal(relay.stats().webMachineSessions, 0);
  console.log('  PASS: every reconnect rechecks current server-side ownership');

  relay.stop();

  console.log('\n[relay machine contract-test] OK\n');
}

main().catch((error) => {
  console.error('[relay machine contract-test] ERROR:', error);
  process.exit(1);
});
