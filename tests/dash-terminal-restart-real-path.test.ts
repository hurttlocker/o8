import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashSessionNameForOwnerKey } from '@/lib/ws-server/dash-terminal-persistence';

type WireFrame = {
  channel?: string;
  event?: string;
  data?: {
    data?: string;
    requestId?: string;
    sessionName?: string;
  };
};

const ownerKey = 'workspace:terminal-restart-real-path';
const expectedSessionName = dashSessionNameForOwnerKey(ownerKey)!;
const beforeMarker = `O8_BEFORE_RESTART_${process.pid}`;
const afterMarker = `O8_AFTER_RESTART_${process.pid}`;
const dataDir = mkdtempSync(join(tmpdir(), 'o8-dash-terminal-restart-'));
const token = 'dash-terminal-restart-token';
const sockets = new Set<WebSocket>();
let apiServer: Server;
let apiPort = 0;
let wsPort = 0;
let wsProcess: ChildProcess | null = null;
let serverOutput = '';

const tmuxAvailable = process.platform !== 'win32' && (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

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
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}. ${serverOutput.slice(-4_000)}`);
}

async function startWsServer() {
  serverOutput = '';
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
      O8_PERSISTENT_TERMINALS: '1',
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
  }, 'ws server health', 30_000);
}

async function stopWsServer() {
  const processToStop = wsProcess;
  wsProcess = null;
  if (!processToStop || processToStop.exitCode !== null) return;
  processToStop.kill('SIGTERM');
  await Promise.race([
    once(processToStop, 'exit'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('ws server did not stop')), 10_000)),
  ]);
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
    'authenticated WebSocket connection',
  );
  return { socket, frames };
}

function terminalText(frames: WireFrame[], sessionName: string) {
  return frames
    .filter((frame) => frame.channel === 'terminal' && frame.event === 'data' && frame.data?.sessionName === sessionName)
    .map((frame) => Buffer.from(frame.data?.data ?? '', 'base64').toString('utf8'))
    .join('');
}

function capturePane() {
  return execFileSync('tmux', ['capture-pane', '-p', '-S', '-', '-t', expectedSessionName], {
    encoding: 'utf8',
  });
}

beforeAll(async () => {
  if (!tmuxAvailable) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  apiPort = await freePort();
  wsPort = await freePort();
  apiServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname === '/api/command-center/snapshot') {
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
    response.end('{}');
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  await startWsServer();
}, 40_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await stopWsServer().catch(() => undefined);
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  try {
    execFileSync('tmux', ['kill-session', '-t', expectedSessionName], { stdio: 'ignore' });
  } catch { /* the assertion may fail before the backing session is created */ }
  rmSync(dataDir, { recursive: true, force: true });
});

describe.runIf(tmuxAvailable)('dashboard terminal restart through the real WebSocket path', () => {
  it('reclaims one owned tmux session with readable scrollback after server loss', async () => {
    const first = await connectClient();
    first.socket.send(JSON.stringify({
      type: 'terminal-create',
      cols: 120,
      rows: 30,
      requestId: 'first-create',
      ownerKey,
    }));
    await waitFor(
      () => first.frames.some((frame) => frame.channel === 'terminal'
        && frame.event === 'created'
        && frame.data?.requestId === 'first-create'),
      'first terminal creation',
    );
    const firstCreated = first.frames.find((frame) => frame.data?.requestId === 'first-create');
    expect(firstCreated?.data?.sessionName).toBe(expectedSessionName);

    first.socket.send(JSON.stringify({
      type: 'terminal-attach',
      sessionName: expectedSessionName,
      cols: 120,
      rows: 30,
    }));
    await waitFor(
      () => first.frames.some((frame) => frame.channel === 'terminal'
        && frame.event === 'attached'
        && frame.data?.sessionName === expectedSessionName),
      'first terminal attachment',
    );
    first.socket.send(JSON.stringify({
      type: 'terminal-input',
      sessionName: expectedSessionName,
      data: `printf '${beforeMarker}\\n'\n`,
    }));
    await waitFor(() => capturePane().includes(beforeMarker), 'pre-restart terminal output');

    first.socket.close();
    await once(first.socket, 'close');
    await stopWsServer();
    expect(capturePane()).toContain(beforeMarker);

    await startWsServer();
    const second = await connectClient();
    second.socket.send(JSON.stringify({
      type: 'terminal-create',
      cols: 120,
      rows: 30,
      requestId: 'second-create',
      ownerKey,
    }));
    await waitFor(
      () => second.frames.some((frame) => frame.channel === 'terminal'
        && frame.event === 'created'
        && frame.data?.requestId === 'second-create'),
      'owned terminal reclamation',
    );
    const secondCreated = second.frames.find((frame) => frame.data?.requestId === 'second-create');
    expect(secondCreated?.data?.sessionName).toBe(expectedSessionName);
    await waitFor(
      () => second.frames.some((frame) => frame.channel === 'terminal'
        && frame.event === 'attached'
        && frame.data?.sessionName === expectedSessionName),
      'restarted terminal attachment',
    );
    await waitFor(
      () => terminalText(second.frames, expectedSessionName).includes(beforeMarker),
      'restored terminal scrollback',
    );

    second.socket.send(JSON.stringify({
      type: 'terminal-input',
      sessionName: expectedSessionName,
      data: `printf '${afterMarker}\\n'\n`,
    }));
    await waitFor(() => capturePane().includes(afterMarker), 'post-restart terminal output');
    expect(capturePane()).toContain(beforeMarker);
    const matchingSessions = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
      .split('\n')
      .filter((name) => name === expectedSessionName);
    expect(matchingSessions).toEqual([expectedSessionName]);
  }, 60_000);
});
