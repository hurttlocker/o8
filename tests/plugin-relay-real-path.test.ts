import { createServer } from 'node:http';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

const steer = vi.hoisted(() => vi.fn(async () => ({ packetId: 'packet-relay', laneId: 'lane-relay', note: 'accepted' })));
vi.mock('@/lib/orchestrator/operator-mission-service', () => ({ steerPacket: steer }));

import { POST } from '@/app/api/plugins/mcp/route';
import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { MachineRelayConnector } from '@/lib/connect/machine-attach';
import { readPluginAudit } from '@/lib/mcp/plugin-audit';
import { panelGateMiddleware } from '@/middleware';

describe('machine connector plugin stream through the gated HTTP entry point', () => {
  it('uses a plugin credential, rejects operator destinations, and never opens an operator realtime bridge', async () => {
    const principals: string[] = [];
    let httpRequests = 0;
    const http = createServer(async (incoming, outgoing) => {
      const body: Buffer[] = [];
      for await (const chunk of incoming) body.push(Buffer.from(chunk));
      const request = new NextRequest(`http://localhost${incoming.url}`, {
        method: incoming.method,
        headers: new Headers(Object.entries(incoming.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(',') : value] as [string, string]])),
        body: Buffer.concat(body),
      });
      httpRequests++;
      principals.push(resolveRequestPrincipal(request));
      const gate = panelGateMiddleware(request);
      const response = gate.status === 200 ? await POST(request) : gate;
      outgoing.writeHead(response.status, { 'content-type': 'application/json' });
      outgoing.end(await response.text());
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('HTTP fixture failed');
    const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const realtime = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await Promise.all([relay, realtime].map((server) => new Promise<void>((resolve) => server.once('listening', resolve))));
    const relayAddress = relay.address();
    const realtimeAddress = realtime.address();
    if (!relayAddress || typeof relayAddress === 'string' || !realtimeAddress || typeof realtimeAddress === 'string') throw new Error('WebSocket fixture failed');
    let realtimeConnections = 0;
    realtime.on('connection', () => { realtimeConnections++; });
    let peer: WebSocket | undefined;
    let capability: string | undefined;
    const receipts = new Map<string, Record<string, unknown>>();
    const waitFor = async (test: () => boolean) => {
      const end = Date.now() + 5000;
      while (!test()) {
        if (Date.now() >= end) throw new Error('plugin relay fixture timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };
    relay.on('connection', (socket, request) => {
      peer = socket;
      capability = request.headers['x-o8-plugin-protocol'] as string | undefined;
      socket.send(JSON.stringify({ t: 'mux-open', sid: 'plugin-stream', surface: 'plugin', grant: { clientId: 'client-relay', scopes: ['o8:read'], expiresAt: Date.now() + 60_000 } }));
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.t === 'mux') {
          const receipt = JSON.parse(Buffer.from(frame.payload, 'base64').toString('utf8'));
          receipts.set(receipt.rid, receipt);
        }
      });
    });
    const connector = new MachineRelayConnector({
      machineId: 'machine-relay', relayUrl: `ws://127.0.0.1:${relayAddress.port}`,
      apiBase: `http://127.0.0.1:${address.port}`, localWebSocketUrl: `ws://127.0.0.1:${realtimeAddress.port}/ws`,
      operatorToken: () => 'fixture-operator-secret',
      ticketProvider: async () => ({ ticket: 'fixture-machine-ticket', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    });
    const send = (rid: string, path: string) => peer!.send(JSON.stringify({ t: 'mux', sid: 'plugin-stream', seq: 0,
      payload: Buffer.from(JSON.stringify({ t: 'http-req', rid, path, method: 'POST', headers: { 'content-type': 'application/json' },
        bodyB64: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_attention', arguments: { machineId: 'machine-relay' } } })).toString('base64'),
        authorization: 'Bearer fixture-operator-secret',
      })).toString('base64'),
    }));
    try {
      connector.start();
      await waitFor(() => Boolean(peer));
      send('status-call', '/api/plugins/mcp');
      await waitFor(() => receipts.has('status-call'));
      expect(capability).toBe('1');
      expect(principals).toEqual(['plugin']);
      expect(receipts.get('status-call')?.status).toBe(200);
      expect(JSON.stringify(receipts.get('status-call'))).not.toContain('fixture-operator-secret');
      send('forbidden-call', '/api/panel/approvals');
      await waitFor(() => receipts.has('forbidden-call'));
      expect(receipts.get('forbidden-call')?.status).toBe(403);
      expect(httpRequests).toBe(1);
      expect(realtimeConnections).toBe(0);
      expect(readPluginAudit().at(-1)).toMatchObject({ actor: 'plugin', surface: 'chatgpt', clientId: 'client-relay' });
      expect(steer).not.toHaveBeenCalled();
    } finally {
      connector.stop('test-complete');
      for (const server of [relay, realtime]) {
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
