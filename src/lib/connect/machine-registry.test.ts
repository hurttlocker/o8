import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deleteMachine,
  issueMachineRelayTicket,
  listMachines,
  registerMachine,
  type MachineDevice,
} from './machine-registry';

interface MockRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

const servers: Server[] = [];

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) as unknown : null;
}

async function startMockServer(
  handler: (request: MockRequest, response: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = createServer(async (request, response) => {
    await handler({
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      authorization: request.headers.authorization,
      body: await readBody(request),
    }, response);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

const device: MachineDevice = {
  machineId: 'machine_1',
  installId: 'install_1',
  name: 'Studio Mac',
  platform: 'darwin',
  appVersion: '1.2.3',
  createdAt: '2026-07-29T10:00:00.000Z',
  lastSeenAt: '2026-07-29T10:00:00.000Z',
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => (
    new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    })
  )));
});

describe('machine registry client', () => {
  it('registers, lists, and deletes through the documented HTTP contract', async () => {
    const requests: MockRequest[] = [];
    const baseUrl = await startMockServer(async (request, response) => {
      requests.push(request);
      if (request.method === 'POST' && request.path === '/machines/register') {
        json(response, 200, { machineId: device.machineId, deviceCap: 3, devices: [device] });
        return;
      }
      if (request.method === 'GET' && request.path === '/machines') {
        json(response, 200, [device]);
        return;
      }
      if (request.method === 'DELETE' && request.path === `/machines/${device.machineId}`) {
        response.writeHead(204);
        response.end();
        return;
      }
      json(response, 404, { error: 'missing fixture route' });
    });
    const options = { baseUrl, token: 'session-or-license-token' };

    const registered = await registerMachine({
      installId: device.installId,
      name: device.name,
      platform: device.platform,
      appVersion: device.appVersion,
    }, options);
    const listed = await listMachines(options);
    const deleted = await deleteMachine(device.machineId, options);

    expect(registered).toEqual({
      ok: true,
      data: { machineId: device.machineId, deviceCap: 3, devices: [device] },
    });
    expect(listed).toEqual({ ok: true, data: [device] });
    expect(deleted).toEqual({ ok: true, data: null });
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/machines/register',
        authorization: 'Bearer session-or-license-token',
        body: {
          installId: 'install_1',
          name: 'Studio Mac',
          platform: 'darwin',
          appVersion: '1.2.3',
        },
      },
      {
        method: 'GET',
        path: '/machines',
        authorization: 'Bearer session-or-license-token',
        body: null,
      },
      {
        method: 'DELETE',
        path: '/machines/machine_1',
        authorization: 'Bearer session-or-license-token',
        body: null,
      },
    ]);
  });

  it('returns the free-tier device list when registration hits the cap', async () => {
    const baseUrl = await startMockServer((_request, response) => {
      json(response, 409, { reason: 'device_cap', deviceCap: 3, devices: [device] });
    });

    const result = await registerMachine({
      installId: 'install_2',
      name: 'Travel Mac',
      platform: 'darwin',
      appVersion: '1.2.3',
    }, { baseUrl, token: 'test-token' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'device_cap',
        status: 409,
        message: 'Free accounts can connect up to 3 devices.',
        deviceCap: 3,
        devices: [device],
      },
    });
  });

  it.each([404, 501])('recovers clearly when the server returns %s', async (status) => {
    const baseUrl = await startMockServer((_request, response) => {
      json(response, status, { error: 'not implemented' });
    });

    const result = await listMachines({ baseUrl, token: 'test-token' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'unsupported',
        status,
        message: 'The o8 license server does not support machine registry yet.',
      },
    });
  });

  it('fetches a machine-scoped relay ticket with the existing account credential', async () => {
    const baseUrl = await startMockServer((request, response) => {
      expect(request).toMatchObject({
        method: 'POST',
        path: '/machines/machine_1/relay-ticket',
        authorization: 'Bearer account-token',
      });
      json(response, 200, {
        ticket: 'signed-machine-ticket',
        expiresAt: '2026-07-29T10:10:00.000Z',
      });
    });

    const result = await issueMachineRelayTicket('machine_1', {
      baseUrl,
      token: 'account-token',
    });

    expect(result).toEqual({
      ok: true,
      data: {
        ticket: 'signed-machine-ticket',
        expiresAt: '2026-07-29T10:10:00.000Z',
      },
    });
  });

  it('distinguishes an absent machine from an unsupported ticket endpoint', async () => {
    const missingBaseUrl = await startMockServer((_request, response) => {
      json(response, 404, { error: 'machine_not_found' });
    });
    const unsupportedBaseUrl = await startMockServer((_request, response) => {
      json(response, 501, { error: 'not_implemented' });
    });

    await expect(issueMachineRelayTicket('missing', {
      baseUrl: missingBaseUrl,
      token: 'account-token',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_registered', status: 404 },
    });
    await expect(issueMachineRelayTicket('machine_1', {
      baseUrl: unsupportedBaseUrl,
      token: 'account-token',
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'unsupported', status: 501 },
    });
  });
});
