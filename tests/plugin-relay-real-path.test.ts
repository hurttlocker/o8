import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';

const steer = vi.hoisted(() => vi.fn(async () => ({ packetId: 'packet-relay', laneId: 'lane-relay', note: 'accepted' })));
vi.mock('@/lib/orchestrator/operator-mission-service', () => ({ steerPacket: steer }));

import { POST } from '@/app/api/plugins/mcp/route';
import { resolveRequestPrincipal, resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { MachineRelayConnector } from '@/lib/connect/machine-attach';
import { getDataDir } from '@/lib/data-dir-migration';
import { bumpSignInEpoch, readSignInEpoch, writeActiveIdentity } from '@/lib/github-broker/managed';
import { allowAccountRefresh, publishReadyAccountState, withAccountStateLease } from '@/lib/auth/account-state';
import { readPluginAudit } from '@/lib/mcp/plugin-audit';
import { panelGateMiddleware } from '@/middleware';

describe('machine connector plugin stream through the gated HTTP entry point', () => {
  it('uses a plugin credential, rejects operator destinations, and never opens an operator realtime bridge', async () => {
    const principals: string[] = [];
    const contexts: Array<ReturnType<typeof resolveRequestPrincipalContext>> = [];
    const originalPublicKey = process.env.O8_LICENSE_PUBKEY;
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
      contexts.push(resolveRequestPrincipalContext(request));
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
    const send = (rid: string, path: string, sid = 'plugin-stream', name = 'o8_attention', extra = {}) => peer!.send(JSON.stringify({ t: 'mux', sid, seq: 0,
      payload: Buffer.from(JSON.stringify({ t: 'http-req', rid, path, method: 'POST', headers: { 'content-type': 'application/json' },
        bodyB64: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { machineId: 'machine-relay', ...extra } } })).toString('base64'),
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
      // New account-bound preparation grant traverses the actual WebSocket
      // connector and HTTP gate, without ever receiving an operator bearer.
      const keys = generateKeyPairSync('ed25519');
      process.env.O8_LICENSE_PUBKEY = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
      const accountId = 'user_relay_draft_fixture';
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: accountId, plan: 'free', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      const unsigned = `${header}.${payload}`;
      const licenseKey = `${unsigned}.${sign(null, Buffer.from(unsigned), keys.privateKey).toString('base64url')}`;
      await withAccountStateLease(() => {
        writeActiveIdentity(accountId);
        bumpSignInEpoch();
        writeFileSync(join(getDataDir(), 'entitlement.json'), JSON.stringify({ plan: 'free', licenseKey }));
        rmSync(join(getDataDir(), 'auth-signed-out-at'), { force: true });
        allowAccountRefresh();
        publishReadyAccountState(accountId, readSignInEpoch()!, licenseKey);
      });
      const expiry = Date.now() + 4000;
      const open = (sid: string, subject?: string, scopes = ['o8:prepare-task']) => peer!.send(JSON.stringify({
        t: 'mux-open', sid, surface: 'plugin', grant: {
          accountId: subject, clientId: 'client-relay', scopes, expiresAt: expiry,
        },
      }));
      send('old-grant-draft', '/api/plugins/mcp', 'plugin-stream', 'o8_task_options');
      await waitFor(() => receipts.has('old-grant-draft'));
      expect(receipts.get('old-grant-draft')?.status).toBe(403);
      open('draft-valid', accountId);
      send('draft-options', '/api/plugins/mcp', 'draft-valid', 'o8_task_options');
      await waitFor(() => receipts.has('draft-options'));
      expect(receipts.get('draft-options')?.status).toBe(200);
      expect(contexts.at(-1)).toMatchObject({ role: 'plugin', accountId, scopes: ['o8:prepare-task'], expiresAt: expiry });
      const taskId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      open('result-read', accountId, ['o8:read']);
      send('bound-result', '/api/plugins/mcp', 'result-read', 'o8_task_result', { taskId });
      await waitFor(() => receipts.has('bound-result'));
      expect(receipts.get('bound-result')?.status).toBe(404); // Authenticated, but no such own task.
      expect(contexts.at(-1)).toMatchObject({ role: 'plugin', accountId, scopes: ['o8:read'], expiresAt: expiry });
      send('result-no-account', '/api/plugins/mcp', 'plugin-stream', 'o8_task_result', { taskId });
      await waitFor(() => receipts.has('result-no-account'));
      expect(receipts.get('result-no-account')?.status).toBe(403);
      open('result-foreign', 'user_foreign_relay_fixture', ['o8:read']);
      send('result-other-account', '/api/plugins/mcp', 'result-foreign', 'o8_task_result', { taskId });
      await waitFor(() => receipts.has('result-other-account'));
      expect(receipts.get('result-other-account')?.status).toBe(403);
      open('draft-foreign', 'user_foreign_relay_fixture');
      send('foreign-options', '/api/plugins/mcp', 'draft-foreign', 'o8_task_options');
      await waitFor(() => receipts.has('foreign-options'));
      expect(receipts.get('foreign-options')?.status).toBe(403);
      const beforeInvalid = httpRequests;
      open('draft-missing-account');
      send('missing-options', '/api/plugins/mcp', 'draft-missing-account', 'o8_task_options');
      // An ordered request on a known stream proves the invalid open was
      // processed. It cannot create a stream or reach the local HTTP server.
      send('invalid-open-barrier', '/api/plugins/mcp');
      await waitFor(() => receipts.has('invalid-open-barrier'));
      expect(httpRequests).toBe(beforeInvalid + 1);
      expect(receipts.has('missing-options')).toBe(false);
      await waitFor(() => Date.now() > expiry);
      const beforeExpired = httpRequests;
      send('expired-options', '/api/plugins/mcp', 'draft-valid', 'o8_task_options');
      await waitFor(() => receipts.has('expired-options'));
      expect(receipts.get('expired-options')?.status).toBe(403);
      expect(httpRequests).toBe(beforeExpired);
      expect(realtimeConnections).toBe(0);
      expect(steer).not.toHaveBeenCalled();
    } finally {
      if (originalPublicKey === undefined) delete process.env.O8_LICENSE_PUBKEY;
      else process.env.O8_LICENSE_PUBKEY = originalPublicKey;
      connector.stop('test-complete');
      for (const server of [relay, realtime]) {
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });
});
