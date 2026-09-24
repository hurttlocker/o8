import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface BridgeMutation {
  runtime?: string;
  status?: string;
}

interface RealtimeFrame {
  channel?: string;
  event?: string;
  data?: {
    events?: Array<{
      channel?: string;
      event?: string;
      data?: { mutation?: BridgeMutation };
    }>;
  };
}

const dataDir = mkdtempSync(join(tmpdir(), 'o8-global-bridge-wire-'));
const token = 'global-bridge-wire-token';
const frames: RealtimeFrame[] = [];
let apiServer: Server;
let wsProcess: ChildProcess;
let socket: WebSocket;
let apiPort = 0;
let wsPort = 0;
let snapshotReads = 0;
let snapshotAvailable = false;
let serverOutput = '';

async function freePort(): Promise<number> {
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

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}. Snapshot reads: ${snapshotReads}. Server tail: ${serverOutput.slice(-1_000)}`);
}

function globalRuntimeSnapshots() {
  return frames.flatMap((frame) => (
    frame.channel === 'realtime' && frame.event === 'batch'
      ? (frame.data?.events ?? []).flatMap((event) => {
        return event.channel === 'runtime' && event.event === 'runtime.snapshot' ? [event] : [];
      })
      : []
  ));
}

beforeAll(async () => {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  apiPort = await freePort();
  wsPort = await freePort();

  apiServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`).pathname;
    if (pathname === '/api/panel/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (pathname === '/api/setup/identity') {
      response.writeHead(snapshotReads >= 5 ? 503 : 200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
      return;
    }
    if (pathname === '/api/command-center/snapshot') {
      snapshotReads += 1;
      if (!snapshotAvailable) {
        response.writeHead(503);
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        fleet: {
          generatedAt: new Date().toISOString(),
          meta: { mode: 'live', sourceLabel: 'test', mirrorMode: 'current-session-first' },
          squads: [], agents: [], events: [], artifacts: [],
        },
        review: null,
        browserInventory: { generatedAt: '', sourceLabel: 'test', surfaces: [] },
        attachedBrowser: null,
      }));
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
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok; }
    catch { return false; }
  }, 'ws-server health', 20_000);
}, 30_000);

afterAll(async () => {
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  if (wsProcess && wsProcess.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
});

describe('global realtime bridge recovery through the websocket', () => {
  it('retries a failed snapshot and publishes recovery without another workspace event', async () => {
    socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    socket.on('message', (raw) => { frames.push(JSON.parse(String(raw)) as RealtimeFrame); });
    await once(socket, 'open');
    socket.send(JSON.stringify({ type: 'realtime-subscribe', subscriptions: [{ stream: 'global' }] }));

    await waitFor(() => snapshotReads >= 3, 'initial failed snapshot requests');
    const failedReads = snapshotReads;

    snapshotAvailable = true;
    await waitFor(() => globalRuntimeSnapshots().length > 0, 'global runtime snapshot after recovery');
    expect(snapshotReads).toBeGreaterThan(failedReads);
  }, 25_000);
});
