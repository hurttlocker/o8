import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { readConnectAttachSetting } from './attach-settings';
import {
  MachineRelayConnector,
  type MachineRelayTicket,
} from './machine-attach';
import { MachineAttachSupervisor } from './machine-attach-supervisor';

type ConnectionRecord = {
  path: string;
  authorization: string | undefined;
  machineId: string | undefined;
};

type RelayHarness = {
  url: string;
  server: WebSocketServer;
  connections: ConnectionRecord[];
};

const harnesses: RelayHarness[] = [];
const temporaryDirectories: string[] = [];

async function startRelay(
  onConnection?: (socket: WebSocket, index: number) => void,
): Promise<RelayHarness> {
  const connections: ConnectionRecord[] = [];
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  server.on('connection', (socket, request) => {
    connections.push({
      path: request.url ?? '',
      authorization: request.headers.authorization,
      machineId: request.headers['x-o8-machine-id'] as string | undefined,
    });
    onConnection?.(socket, connections.length - 1);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('relay fixture did not bind');
  const harness = {
    url: `ws://127.0.0.1:${address.port}`,
    server,
    connections,
  };
  harnesses.push(harness);
  return harness;
}

function ticket(machineId: string, sequence = 1): MachineRelayTicket {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return {
    ticket: compactJwt(
      { alg: 'EdDSA', typ: 'JWT' },
      {
        accountId: 'account_1',
        machineId,
        installId: 'install_1',
        aud: 'o8-relay',
        iat: nowSeconds,
        exp: nowSeconds + 600,
        sequence,
      },
    ),
    expiresAt: new Date(Date.now() + 10 * 60 * 1_000).toISOString(),
  };
}

function compactJwt(
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  return [
    Buffer.from(JSON.stringify(header)).toString('base64url'),
    Buffer.from(JSON.stringify(claims)).toString('base64url'),
    Buffer.from('fixture-signature').toString('base64url'),
  ].join('.');
}

function decodeJwtPart(tokenValue: string, index: number): Record<string, unknown> {
  const part = tokenValue.split('.')[index];
  if (!part) throw new Error('invalid fixture jwt');
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function parseFrame(raw: RawData): Record<string, unknown> {
  return JSON.parse(raw.toString()) as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for relay fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(async ({ server }) => {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('machine relay attach real path', () => {
  it('presents the machine ticket and serves generic web HTTP mux through the local operator gate', async () => {
    let responseFrame: Record<string, unknown> | null = null;
    const localWebSocket = await startRelay();
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'mux-open', sid: 'web-1' }));
      socket.on('message', (raw) => {
        const outer = parseFrame(raw);
        if (outer.t === 'mux-ready') {
          socket.send(JSON.stringify({
            t: 'mux',
            sid: 'web-1',
            seq: 1,
            payload: Buffer.from(JSON.stringify({
              t: 'http-req',
              rid: 'request-1',
              method: 'GET',
              path: '/api/panel/repos',
              authorization: 'Bearer untrusted-web-value',
            }), 'utf8').toString('base64'),
          }));
          return;
        }
        if (outer.t === 'mux' && typeof outer.payload === 'string') {
          responseFrame = JSON.parse(
            Buffer.from(outer.payload, 'base64').toString('utf8'),
          ) as Record<string, unknown>;
        }
      });
    });
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init });
      return new Response(JSON.stringify({ repos: [{ localPath: '/work/repo' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const machineId = 'machine_01HREALPATH';
    const issued = ticket(machineId);
    const connector = new MachineRelayConnector({
      machineId,
      relayUrl: relay.url,
      apiBase: 'http://127.0.0.1:47120',
      localWebSocketUrl: `${localWebSocket.url}/ws`,
      operatorToken: () => 'local-operator-token',
      ticketProvider: async () => issued,
      fetchImpl,
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });

    connector.start();
    await waitFor(() => responseFrame !== null);

    expect(relay.connections).toHaveLength(1);
    expect(relay.connections[0]).toMatchObject({
      path: '/machine',
      machineId,
      authorization: `Bearer ${issued.ticket}`,
    });
    expect(decodeJwtPart(issued.ticket, 0)).toEqual({ alg: 'EdDSA', typ: 'JWT' });
    expect(decodeJwtPart(issued.ticket, 1)).toMatchObject({
      accountId: 'account_1',
      machineId,
      installId: 'install_1',
      aud: 'o8-relay',
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe('http://127.0.0.1:47120/api/panel/repos');
    const headers = new Headers(fetchCalls[0]?.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer local-operator-token');
    expect(headers.get('x-o8-client-addr')).toBe('o8-relay-forward');
    expect(headers.get('x-o8-relay-forward')).toBe('1');
    expect(responseFrame).toMatchObject({
      t: 'http-res',
      rid: 'request-1',
      status: 200,
    });

    connector.stop('test-complete');
  });

  it('fetches a fresh ticket and reconnects after the relay drops the socket', async () => {
    const relay = await startRelay((socket, index) => {
      if (index === 0) {
        setTimeout(() => socket.close(1012, 'fixture-drop'), 10);
      }
    });
    let issued = 0;
    const connector = new MachineRelayConnector({
      machineId: 'machine_reconnect',
      relayUrl: relay.url,
      ticketProvider: async () => ticket('machine_reconnect', ++issued),
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });

    connector.start();
    await waitFor(() => relay.connections.length >= 2);

    expect(issued).toBeGreaterThanOrEqual(2);
    expect(relay.connections.every((entry) => entry.path === '/machine')).toBe(true);
    expect(relay.connections.every((entry) => entry.machineId === 'machine_reconnect')).toBe(true);
    expect(relay.connections[0]?.authorization).not.toBe(relay.connections[1]?.authorization);

    connector.stop('test-complete');
  });

  it('bridges each web-machine stream to the local realtime socket and tears it down', async () => {
    let localReceived = '';
    let relayedReply = '';
    let localClosed = false;
    const localWebSocket = await startRelay((socket) => {
      socket.on('message', (raw) => {
        localReceived = raw.toString();
        socket.send(JSON.stringify({ channel: 'pong', seq: 7 }));
      });
      socket.on('close', () => {
        localClosed = true;
      });
    });
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'mux-open', sid: 'web-realtime' }));
      socket.on('message', (raw) => {
        const outer = parseFrame(raw);
        if (outer.t === 'mux-ready') {
          socket.send(JSON.stringify({
            t: 'mux',
            sid: 'web-realtime',
            seq: 1,
            payload: Buffer.from(JSON.stringify({ type: 'ping' }), 'utf8').toString('base64'),
          }));
          return;
        }
        if (outer.t === 'mux' && typeof outer.payload === 'string') {
          relayedReply = Buffer.from(outer.payload, 'base64').toString('utf8');
          socket.send(JSON.stringify({ t: 'mux-close', sid: 'web-realtime' }));
        }
      });
    });
    const connector = new MachineRelayConnector({
      machineId: 'machine_realtime',
      relayUrl: relay.url,
      localWebSocketUrl: `${localWebSocket.url}/ws`,
      operatorToken: () => 'local-operator-token',
      ticketProvider: async () => ticket('machine_realtime'),
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });

    connector.start();
    await waitFor(() => localReceived.length > 0 && relayedReply.length > 0 && localClosed);

    expect(localWebSocket.connections).toEqual([{
      path: '/ws?token=local-operator-token',
      authorization: undefined,
      machineId: undefined,
    }]);
    expect(localReceived).toBe(JSON.stringify({ type: 'ping' }));
    expect(relayedReply).toBe(JSON.stringify({ channel: 'pong', seq: 7 }));

    connector.stop('test-complete');
  });

  it('rotates the relay ticket before expiry without waiting for a socket drop', async () => {
    let localBridgeCloses = 0;
    const localWebSocket = await startRelay((socket) => {
      socket.on('close', () => {
        localBridgeCloses++;
      });
    });
    const relay = await startRelay((socket) => {
      socket.send(JSON.stringify({ t: 'devices', count: 0 }));
      socket.send(JSON.stringify({ t: 'mux-open', sid: 'refresh-stream' }));
    });
    let issued = 0;
    const connector = new MachineRelayConnector({
      machineId: 'machine_refresh',
      relayUrl: relay.url,
      localWebSocketUrl: `${localWebSocket.url}/ws`,
      operatorToken: () => 'local-operator-token',
      ticketProvider: async () => ticket('machine_refresh', ++issued),
      refreshIntervalMs: 40,
      expiryLeadMs: 0,
      reconnectBaseMs: 20,
      reconnectCapMs: 40,
    });

    connector.start();
    await waitFor(() => relay.connections.length >= 2);

    expect(issued).toBeGreaterThanOrEqual(2);
    expect(relay.connections[0]?.authorization).not.toBe(relay.connections[1]?.authorization);
    expect(localWebSocket.connections).toHaveLength(1);
    expect(localBridgeCloses).toBe(0);

    connector.stop('test-complete');
  });

  it('defaults OFF and the supervisor opens no relay socket without operator opt-in', async () => {
    const relay = await startRelay();
    const dataDir = mkdtempSync(path.join(tmpdir(), 'o8-connect-off-'));
    temporaryDirectories.push(dataDir);
    const setting = readConnectAttachSetting({ env: {}, dataDir });
    const createConnector = vi.fn(() => new MachineRelayConnector({
      machineId: 'machine_off',
      relayUrl: relay.url,
      ticketProvider: async () => ticket('machine_off'),
    }));
    const listRegisteredMachines = vi.fn(async () => [{
      machineId: 'machine_off',
      installId: 'install_off',
      name: 'Off Mac',
      platform: 'darwin',
      appVersion: '0.1.0',
    }]);
    const supervisor = new MachineAttachSupervisor({
      reconcileIntervalMs: 20,
      readEnabled: () => setting.enabled,
      readCredential: () => 'account-token',
      readInstallId: () => 'install_off',
      listRegisteredMachines,
      createConnector,
    });

    supervisor.start();
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(setting).toEqual({ enabled: false, source: 'default', locked: false });
    expect(listRegisteredMachines).not.toHaveBeenCalled();
    expect(createConnector).not.toHaveBeenCalled();
    expect(relay.connections).toHaveLength(0);

    supervisor.stop();
  });

  it('detaches the active machine promptly when the cached account credential disappears', async () => {
    let credential: string | null = 'account-token';
    const start = vi.fn();
    const stop = vi.fn();
    const supervisor = new MachineAttachSupervisor({
      reconcileIntervalMs: 60_000,
      readEnabled: () => true,
      readCredential: () => credential,
      readInstallId: () => 'install_signed_in',
      listRegisteredMachines: async () => [{
        machineId: 'machine_signed_in',
        installId: 'install_signed_in',
        name: 'Signed-in Mac',
        platform: 'darwin',
        appVersion: '0.1.0',
      }],
      createConnector: () => ({ start, stop }),
    });

    supervisor.start();
    await waitFor(() => start.mock.calls.length === 1);
    credential = null;
    await supervisor.reconcile();

    expect(stop).toHaveBeenCalledWith('signed-out');
    supervisor.stop();
  });
});
