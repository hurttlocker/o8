import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type WireFrame = Record<string, unknown> & {
  channel?: string;
  event?: string;
  seq?: number;
  capturedSeq?: number;
  data?: Record<string, unknown>;
};

const dataDir = mkdtempSync(join(tmpdir(), 'o8-realtime-protocol-'));
const token = 'realtime-protocol-token';
const sockets = new Set<WebSocket>();
let apiServer: Server;
let wsProcess: ChildProcess;
let apiPort = 0;
let wsPort = 0;
let serverOutput = '';
let inboxMarker = 'initial';
let historyVersion = 0;
let historyUnavailable = false;

function inbox() {
  return {
    generatedAt: new Date().toISOString(),
    mode: 'live',
    sourceLabel: 'o8',
    sessions: [],
    fleetSessions: [],
    approvals: [],
    reviewUnits: [],
    items: Array.from({ length: 20 }, (_, index) => ({
      id: `item-${index}`,
      kind: 'alert',
      title: `Item ${index}`,
      detail: 'x'.repeat(400),
    })),
    summary: { marker: inboxMarker },
  };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}. ${serverOutput.slice(-2_000)}`);
}

async function connectClient() {
  const frames: WireFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as WireFrame));
  socket.on('close', () => sockets.delete(socket));
  await once(socket, 'open');
  await waitFor(
    () => frames.some((frame) => frame.channel === 'system' && frame.event === 'connected'),
    'authenticated connection welcome',
  );
  return { socket, frames };
}

function realtimeEvents(frames: WireFrame[]) {
  return frames.flatMap((frame) => {
    if (frame.channel !== 'realtime' || frame.event !== 'batch') return [];
    const events = Array.isArray(frame.data?.events) ? frame.data.events as WireFrame[] : [];
    return events.map((event) => ({
      ...event,
      delivery: frame.data?.delivery,
      gap: frame.data?.gap,
    }));
  });
}

function realtimeBatches(frames: WireFrame[]) {
  return frames.filter((frame) => frame.channel === 'realtime' && frame.event === 'batch');
}

async function requestRefresh(target: 'mobileInbox' | 'sessionHistory') {
  const response = await fetch(`http://127.0.0.1:${wsPort}/internal/realtime`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'refresh',
      targets: [target],
      ...(target === 'sessionHistory' ? { sessionKeys: ['worker-protocol'] } : {}),
      fresh: true,
      reason: 'protocol real-path test',
    }),
  });
  expect(response.status).toBe(202);
}

beforeAll(async () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  apiPort = await freePort();
  wsPort = await freePort();
  apiServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;

    if (url.pathname === '/api/mobile/inbox' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(inbox()));
      return;
    }

    if (url.pathname === '/api/mobile/sync' && request.method === 'POST') {
      if (body.inbox) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ inbox: inbox(), inboxEtag: inboxMarker }));
        return;
      }
      const history = body.history as { sessionKey?: string } | undefined;
      if (history?.sessionKey) {
        if (historyUnavailable) {
          response.writeHead(503, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'history temporarily unavailable' }));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          history: {
            sessionKey: history.sessionKey,
            entries: [{
              id: `history-${historyVersion}`,
              role: 'assistant',
              text: `history ${historyVersion}`,
            }],
            replace: true,
          },
        }));
        return;
      }
    }

    if (url.pathname === '/api/command-center/snapshot') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        fleet: { agents: [], meta: { mode: 'live' } },
        review: null,
        reviewError: null,
        browserInventory: { browsers: [], generatedAt: new Date().toISOString() },
        attachedBrowser: null,
        browserError: null,
      }));
      return;
    }

    if (url.pathname === '/api/setup/identity') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ configured: false }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');

  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_REALTIME_LOG_LIMIT: '4',
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok; } catch { return false; }
  }, 'ws server health', 30_000);
}, 40_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (wsProcess && wsProcess.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('versioned realtime protocol through the WebSocket entry point', () => {
  it('rejects a malformed required-capability list without terminating the server', async () => {
    const client = await connectClient();
    client.socket.send(JSON.stringify({
      type: 'realtime-negotiate',
      protocol: { min: 1, max: 1 },
      appVersion: '1.0.0',
      clientKind: 'mobile',
      capabilities: [],
      requiredCapabilities: 'mobile-inbox-delta-v1',
    }));
    await waitFor(
      () => client.frames.some((frame) => frame.channel === 'realtime' && frame.event === 'incompatible'),
      'malformed hello rejection',
    );
    expect((await fetch(`http://127.0.0.1:${wsPort}/health`)).ok).toBe(true);
  });

  it('selects features and emits an optional event only to the capable client', async () => {
    const current = await connectClient();
    const oldest = await connectClient();
    current.socket.send(JSON.stringify({
      type: 'realtime-negotiate',
      protocol: { min: 1, max: 1 },
      appVersion: '1.0.0',
      clientKind: 'mobile',
      capabilities: ['mobile-inbox-delta-v1'],
    }));
    await waitFor(
      () => current.frames.some((frame) => frame.channel === 'realtime' && frame.event === 'welcome'),
      'protocol welcome',
    );
    const welcome = current.frames.find((frame) => frame.event === 'welcome');
    expect(welcome?.data).toMatchObject({ protocol: 1, features: ['mobile-inbox-delta-v1'] });
    expect(welcome?.data?.epoch).toEqual(expect.any(String));

    current.socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
    oldest.socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
    await waitFor(
      () => realtimeEvents(current.frames).some((event) => event.event === 'mobile.inbox.snapshot')
        && realtimeEvents(oldest.frames).some((event) => event.event === 'mobile.inbox.snapshot'),
      'current and oldest client bootstrap',
    );

    inboxMarker = 'changed';
    await requestRefresh('mobileInbox');
    await waitFor(
      () => realtimeEvents(current.frames).some((event) => event.event === 'mobile.inbox.delta')
        && realtimeEvents(oldest.frames).filter((event) => event.event === 'mobile.inbox.snapshot').length >= 2,
      'capability-gated delta and legacy snapshot',
    );
    expect(realtimeEvents(oldest.frames).some((event) => event.event === 'mobile.inbox.delta')).toBe(false);
    const liveFullSnapshot = realtimeEvents(oldest.frames).find((event) => (
      event.delivery === 'live' && event.event === 'mobile.inbox.snapshot'
    ));
    expect(liveFullSnapshot).toMatchObject({
      snapshot: true,
      capturedSeq: expect.any(Number),
    });
    expect(Number(liveFullSnapshot?.capturedSeq)).toBeLessThan(Number(liveFullSnapshot?.seq));
    const currentBatch = realtimeBatches(current.frames).find((frame) => frame.data?.epoch);
    expect(currentBatch?.data?.epoch).toBe(welcome?.data?.epoch);
    current.socket.close();
    oldest.socket.close();
  }, 30_000);

  it('forces an authoritative checkpoint for a cursor from another server epoch', async () => {
    const client = await connectClient();
    client.socket.send(JSON.stringify({
      type: 'realtime-negotiate',
      protocol: { min: 1, max: 1 },
      appVersion: '1.0.0',
      clientKind: 'mobile',
      capabilities: ['mobile-inbox-delta-v1'],
    }));
    await waitFor(
      () => client.frames.some((frame) => frame.channel === 'realtime' && frame.event === 'welcome'),
      'epoch-bearing protocol welcome',
    );
    const welcome = client.frames.find((frame) => frame.channel === 'realtime' && frame.event === 'welcome');
    const epoch = welcome?.data?.epoch;
    expect(epoch).toEqual(expect.any(String));

    client.socket.send(JSON.stringify({
      type: 'realtime-subscribe',
      subscriptions: [{ stream: 'global', epoch: 'retired-server-epoch', since: 999_999 }],
    }));
    await waitFor(
      () => realtimeBatches(client.frames).some((frame) => (
        frame.data?.delivery === 'bootstrap' && Boolean(frame.data?.gap)
      )),
      'new-epoch checkpoint',
    );
    const checkpoint = realtimeBatches(client.frames).find((frame) => (
      frame.data?.delivery === 'bootstrap' && Boolean(frame.data?.gap)
    ));
    expect(checkpoint?.data).toMatchObject({
      epoch,
      gap: { requestedSince: 999_999 },
    });
    const checkpointEvents = Array.isArray(checkpoint?.data?.events)
      ? checkpoint.data.events as WireFrame[]
      : [];
    expect(checkpointEvents.some((event) => event.snapshot === true)).toBe(true);
    expect(Number(checkpoint?.data?.latestSeq)).toBeLessThan(999_999);
    client.socket.close();
  }, 30_000);

  it('rejects an unsupported required protocol before subscription', async () => {
    const client = await connectClient();
    client.socket.send(JSON.stringify({
      type: 'realtime-negotiate',
      protocol: { min: 2, max: 2 },
      appVersion: '2.0.0',
      clientKind: 'mobile',
      capabilities: [],
    }));
    client.socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));
    await waitFor(
      () => client.frames.some((frame) => frame.channel === 'realtime' && frame.event === 'incompatible'),
      'human-readable incompatibility',
    );
    const incompatible = client.frames.find((frame) => frame.event === 'incompatible');
    expect(incompatible?.data).toMatchObject({ updateRequired: true, supportedProtocol: { min: 1, max: 1 } });
    expect(String(incompatible?.data?.reason)).toContain('Update o8 mobile');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(realtimeEvents(client.frames)).toHaveLength(0);
    client.socket.close();
  }, 30_000);

  it('keeps legacy replay and forces a snapshot after a retained-log gap', async () => {
    const first = await connectClient();
    first.socket.send(JSON.stringify({
      type: 'realtime-subscribe',
      subscriptions: [{ stream: 'session:worker-protocol' }],
    }));
    await waitFor(
      () => realtimeEvents(first.frames).some((event) => event.event === 'history.snapshot'),
      'legacy history bootstrap',
    );
    historyVersion = 1;
    await requestRefresh('sessionHistory');
    await waitFor(
      () => realtimeEvents(first.frames).some((event) => event.delivery === 'live' && event.event === 'history.snapshot'),
      'retained history event',
    );
    const retained = realtimeEvents(first.frames).find((event) => event.delivery === 'live');
    const retainedSeq = Number(retained?.seq);
    const retainedEpoch = realtimeBatches(first.frames).find((frame) => (
      Array.isArray(frame.data?.events)
        && (frame.data.events as WireFrame[]).some((event) => event.seq === retainedSeq)
    ))?.data?.epoch;
    expect(retainedEpoch).toEqual(expect.any(String));
    first.socket.close();

    const unbound = await connectClient();
    unbound.socket.send(JSON.stringify({
      type: 'realtime-subscribe',
      subscriptions: [{ stream: 'session:worker-protocol', since: retainedSeq - 1 }],
    }));
    await waitFor(
      () => realtimeBatches(unbound.frames).some((frame) => Boolean(frame.data?.gap)),
      'epochless cursor checkpoint',
    );
    expect(realtimeBatches(unbound.frames).find((frame) => frame.data?.gap)?.data).toMatchObject({
      epoch: retainedEpoch,
      delivery: 'bootstrap',
      gap: { requestedSince: retainedSeq - 1 },
    });
    unbound.socket.close();

    const replay = await connectClient();
    replay.socket.send(JSON.stringify({
      type: 'realtime-subscribe',
      subscriptions: [{ stream: 'session:worker-protocol', epoch: retainedEpoch, since: retainedSeq - 1 }],
    }));
    await waitFor(
      () => realtimeEvents(replay.frames).some((event) => event.delivery === 'replay' && event.seq === retainedSeq),
      'retained replay',
    );

    let latestSeq = retainedSeq;
    for (let version = 2; version <= 7; version += 1) {
      historyVersion = version;
      await requestRefresh('sessionHistory');
      await waitFor(() => {
        const live = realtimeEvents(replay.frames).filter((event) => event.delivery === 'live');
        const next = live.find((event) => Number(event.seq) > latestSeq);
        if (!next) return false;
        latestSeq = Number(next.seq);
        return true;
      }, `history version ${version}`);
    }
    replay.socket.close();

    const gap = await connectClient();
    gap.socket.send(JSON.stringify({
      type: 'realtime-subscribe',
      subscriptions: [{ stream: 'session:worker-protocol', epoch: retainedEpoch, since: retainedSeq }],
    }));
    await waitFor(
      () => realtimeEvents(gap.frames).some((event) => (
        event.delivery === 'bootstrap'
          && event.event === 'history.snapshot'
          && Boolean(event.gap)
      )),
      'forced gap checkpoint',
    );
    const recovered = realtimeEvents(gap.frames).find((event) => event.delivery === 'bootstrap' && event.gap);
    expect(recovered?.gap).toMatchObject({ requestedSince: retainedSeq });
    gap.socket.close();
  }, 30_000);

  it('emits replay-gap truth even when checkpoint construction fails', async () => {
    const seed = await connectClient();
    seed.socket.send(JSON.stringify({
      type: 'realtime-subscribe',
      subscriptions: [{ stream: 'session:worker-gap-failure' }],
    }));
    await waitFor(
      () => realtimeEvents(seed.frames).some((event) => event.event === 'history.snapshot'),
      'gap failure seed',
    );
    const seedSeq = Number(realtimeEvents(seed.frames).at(-1)?.seq);
    for (let version = 20; version <= 26; version += 1) {
      historyVersion = version;
      await requestRefresh('sessionHistory');
    }
    seed.socket.close();

    historyUnavailable = true;
    const gap = await connectClient();
    gap.socket.send(JSON.stringify({
      type: 'realtime-subscribe',
      subscriptions: [{ stream: 'session:worker-gap-failure', since: seedSeq }],
    }));
    await waitFor(
      () => realtimeBatches(gap.frames).some((frame) => Boolean(frame.data?.gap)),
      'gap-only failure descriptor',
    );
    const batch = realtimeBatches(gap.frames).find((frame) => frame.data?.gap);
    expect(batch?.data).toMatchObject({
      delivery: 'bootstrap',
      events: [],
      gap: { requestedSince: seedSeq },
    });
    historyUnavailable = false;
    gap.socket.close();
  }, 30_000);
});
