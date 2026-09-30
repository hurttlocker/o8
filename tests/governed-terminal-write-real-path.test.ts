import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { renderTerminalBytes } from './helpers/headless-terminal';

type WireFrame = {
  channel?: string;
  event?: string;
  data?: {
    sessionName?: string;
    data?: string;
  };
};

const dataDir = mkdtempSync(join(tmpdir(), 'o8-governed-terminal-write-'));
const operatorToken = `governed-terminal-operator-${process.pid}-0123456789`;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
writeFileSync(join(dataDir, 'ws-token'), `${operatorToken}\n`, { mode: 0o600 });

const laneRegistry = await import('@/lib/lane/registry');
const packetTokens = await import('@/lib/auth/packet-worker-token');
const db = await import('@/lib/db');

const packetA = `packet-terminal-a-${Date.now()}`;
const packetB = `packet-terminal-b-${Date.now()}`;
const laneB = laneRegistry.createLane({
  label: 'governed terminal owner',
  repoPath: '/tmp/o8-governed-terminal-b',
  worktreePath: '/tmp/o8-governed-terminal-b',
  branch: 'agent/governed-terminal-b',
  baseBranch: 'main',
  runtime: 'codex',
  packetId: packetB,
});
const workerTokenA = packetTokens.mintPacketWorkerToken(packetA);
const workerTokenB = packetTokens.mintPacketWorkerToken(packetB);

const baselineSession = `cortex-governed-baseline-${process.pid}`;
const governedSession = `cortex-governed-target-${process.pid}`;
const sockets = new Set<WebSocket>();
let apiServer: Server | null = null;
let apiPort = 0;
let wsPort = 0;
let wsProcess: ChildProcess | null = null;
let serverOutput = '';

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

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}. ${serverOutput.slice(-4_000)}`);
}

async function startWsServer() {
  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok;
    } catch {
      return false;
    }
  }, 'ws-server health', 30_000);
}

async function stopWsServer() {
  const running = wsProcess;
  wsProcess = null;
  if (!running || running.exitCode !== null) return;
  running.kill('SIGTERM');
  await Promise.race([
    once(running, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('ws-server did not stop')), 10_000)),
  ]);
}

async function spawnOwnedTerminal(sessionName: string) {
  const response = await fetch(`http://127.0.0.1:${wsPort}/terminal-spawn`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${operatorToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      sessionName,
      shellCommand: 'cat',
      cwd: process.cwd(),
      cols: 80,
      rows: 20,
      packetId: packetB,
      laneId: laneB.id,
    }),
  });
  expect(response.status).toBe(200);
}

async function connectTerminal(sessionName: string) {
  const frames: WireFrame[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(operatorToken)}`);
  sockets.add(socket);
  socket.on('message', (raw) => frames.push(JSON.parse(String(raw)) as WireFrame));
  socket.on('close', () => sockets.delete(socket));
  await once(socket, 'open');
  await waitFor(
    () => frames.some((frame) => frame.channel === 'system' && frame.event === 'connected'),
    'authenticated terminal websocket',
  );
  socket.send(JSON.stringify({
    type: 'terminal-attach',
    sessionName,
    cols: 80,
    rows: 20,
  }));
  await waitFor(
    () => frames.some((frame) => frame.channel === 'terminal'
      && frame.event === 'attached'
      && frame.data?.sessionName === sessionName),
    `terminal attach ${sessionName}`,
  );
  return { socket, frames };
}

function decodedTerminal(frames: WireFrame[], start: number, sessionName: string) {
  return frames.slice(start)
    .filter((frame) => frame.channel === 'terminal'
      && frame.event === 'data'
      && frame.data?.sessionName === sessionName
      && typeof frame.data.data === 'string')
    .map((frame) => Buffer.from(frame.data!.data!, 'base64').toString('utf8'));
}

async function postGoverned(token: string, sessionId: string, data: string, reason: string) {
  return fetch(`http://127.0.0.1:${wsPort}/terminal-agent-input`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId, data, reason }),
  });
}

beforeAll(async () => {
  apiPort = await freePort();
  wsPort = await freePort();
  apiServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  await startWsServer();
  await spawnOwnedTerminal(baselineSession);
  await spawnOwnedTerminal(governedSession);
}, 40_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await stopWsServer().catch(() => undefined);
  if (apiServer?.listening) {
    await new Promise<void>((resolve) => apiServer!.close(() => resolve()));
  }
  db.closeDb();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('governed packet-worker terminal input through the real PTY path', () => {
  it('refuses cross-packet input, records the owning action, and renders byte-identically', async () => {
    const baseline = await connectTerminal(baselineSession);
    const governed = await connectTerminal(governedSession);

    const beforeActions = laneRegistry.getLaneEvents(laneB.id, 100)
      .filter((event) => event.verb === 'terminal_action').length;
    const governedStart = governed.frames.length;

    const denied = await postGoverned(
      workerTokenA,
      governedSession,
      'O8_FORBIDDEN_CROSS_PACKET\r',
      'cross-packet sabotage probe',
    );
    expect(denied.status).toBe(403);
    await expect(denied.json()).resolves.toMatchObject({ error: 'terminal_packet_mismatch' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(decodedTerminal(governed.frames, governedStart, governedSession).join(''))
      .not.toContain('O8_FORBIDDEN_CROSS_PACKET');
    expect(laneRegistry.getLaneEvents(laneB.id, 100)
      .filter((event) => event.verb === 'terminal_action')).toHaveLength(beforeActions);

    const bytes = '\x1b[2J\x1b[HO8_GOVERNED_2229\r\nsecond-line\r\n';
    const baselineStart = baseline.frames.length;
    baseline.socket.send(JSON.stringify({
      type: 'terminal-input',
      sessionName: baselineSession,
      data: bytes,
    }));

    const accepted = await postGoverned(
      workerTokenB,
      governedSession,
      bytes,
      'structured terminal adapter action',
    );
    expect(accepted.status).toBe(200);
    const body = await accepted.json() as {
      receipt: { packetId: string; sessionId: string; laneId: string; byteCount: number; reason: string };
    };
    expect(body.receipt).toMatchObject({
      packetId: packetB,
      sessionId: governedSession,
      laneId: laneB.id,
      byteCount: Buffer.byteLength(bytes, 'utf8'),
      reason: 'structured terminal adapter action',
    });

    await waitFor(
      () => decodedTerminal(baseline.frames, baselineStart, baselineSession).join('').includes('second-line'),
      'baseline terminal output',
    );
    await waitFor(
      () => decodedTerminal(governed.frames, governedStart, governedSession).join('').includes('second-line'),
      'governed terminal output',
    );

    const [baselineRows, governedRows] = await Promise.all([
      renderTerminalBytes(decodedTerminal(baseline.frames, baselineStart, baselineSession), {
        cols: 80, rows: 20, scrollback: 200,
      }),
      renderTerminalBytes(decodedTerminal(governed.frames, governedStart, governedSession), {
        cols: 80, rows: 20, scrollback: 200,
      }),
    ]);
    expect(governedRows).toEqual(baselineRows);

    await waitFor(
      () => laneRegistry.getLaneEvents(laneB.id, 100)
        .filter((event) => event.verb === 'terminal_action').length === beforeActions + 1,
      'durable terminal action event',
    );
    const action = laneRegistry.getLaneEvents(laneB.id, 100)
      .find((event) => event.verb === 'terminal_action');
    expect(action?.actor).toBe('orchestrator');
    expect(action?.payload).toMatchObject({
      packetId: packetB,
      sessionId: governedSession,
      byteCount: Buffer.byteLength(bytes, 'utf8'),
      reason: 'structured terminal adapter action',
      principal: 'worker',
      result: 'attempted',
    });
  }, 30_000);
});
