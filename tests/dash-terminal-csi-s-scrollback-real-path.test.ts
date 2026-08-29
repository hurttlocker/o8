import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dashSessionNameForOwnerKey } from '@/lib/ws-server/dash-terminal-persistence';
import { renderTerminalBytes } from './helpers/headless-terminal';

type WireFrame = {
  channel?: string;
  event?: string;
  data?: { data?: string; requestId?: string; sessionName?: string };
};

const ESC = String.fromCharCode(27);
const CSI_S = new RegExp(`${ESC}\\[[0-9]*S`);
const COLS = 20;
const ROWS = 5;
const LINE_COUNT = 40;
const dataDir = mkdtempSync(join(tmpdir(), 'o8-csi-s-ws-xterm-'));
const token = `dash-terminal-csi-s-${process.pid}`;
const dashboardServerName = `o8-dashboard-test-${process.pid}`;
const dashboardTmuxArgs = (...args: string[]) => ['-L', dashboardServerName, ...args];
const fixedOwner = `csi-s-fixed-${process.pid}`;
const secondOwner = `csi-s-second-${process.pid}`;
const fixedSession = dashSessionNameForOwnerKey(fixedOwner)!;
const secondSession = dashSessionNameForOwnerKey(secondOwner)!;
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

async function waitFor(predicate: () => boolean | Promise<boolean>, description: string, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}. ${serverOutput.slice(-4_000)}`);
}

function defaultTmuxOverrides(): string | null {
  try {
    return execFileSync('tmux', ['show-options', '-gv', 'terminal-overrides'], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function capturePane(sessionName: string) {
  return execFileSync('tmux', dashboardTmuxArgs('capture-pane', '-p', '-S', '-', '-t', sessionName), { encoding: 'utf8' });
}

function numberedLines(text: string): string[] {
  return [...text.matchAll(/\b(\d{3})\b/g)].map((match) => match[1]!);
}

async function renderPayload(payload: string) {
  return numberedLines((await renderTerminalBytes(
    [Buffer.from(payload, 'base64').toString('utf8')],
    { cols: COLS, rows: ROWS, scrollback: 1_000 },
  )).join('\n'));
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
      O8_DASH_TMUX_SERVER_NAME: dashboardServerName,
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(async () => {
    try { return (await fetch(`http://127.0.0.1:${wsPort}/health`)).ok; } catch { return false; }
  }, 'ws server health', 30_000);
}

async function stopWsServer() {
  const running = wsProcess;
  wsProcess = null;
  if (!running || running.exitCode !== null) return;
  running.kill('SIGTERM');
  await Promise.race([once(running, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
}

async function connectRenderedClient() {
  const frames: WireFrame[] = [];
  const decodedChunks: string[] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  sockets.add(socket);
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw)) as WireFrame;
    frames.push(frame);
    if (frame.channel !== 'terminal' || frame.event !== 'data' || typeof frame.data?.data !== 'string') return;
    decodedChunks.push(Buffer.from(frame.data.data, 'base64').toString('utf8'));
  });
  socket.on('close', () => sockets.delete(socket));
  await once(socket, 'open');
  await waitFor(
    () => frames.some((frame) => frame.channel === 'system' && frame.event === 'connected'),
    'authenticated WebSocket connection',
  );
  return {
    socket,
    frames,
    raw: () => decodedChunks.join(''),
    renderedRows: () => renderTerminalBytes(decodedChunks, { cols: COLS, rows: ROWS, scrollback: 1_000 }),
  };
}

async function createAndFill(ownerKey: string, sessionName: string) {
  const client = await connectRenderedClient();
  client.socket.send(JSON.stringify({
    type: 'terminal-create',
    cols: COLS,
    rows: ROWS,
    requestId: ownerKey,
    ownerKey,
  }));
  await waitFor(
    () => client.frames.some((frame) => frame.event === 'created' && frame.data?.sessionName === sessionName),
    `${ownerKey} creation`,
  );
  client.socket.send(JSON.stringify({ type: 'terminal-attach', sessionName, cols: COLS, rows: ROWS }));
  await waitFor(
    () => client.frames.some((frame) => frame.event === 'attached' && frame.data?.sessionName === sessionName),
    `${ownerKey} attachment`,
  );
  client.socket.send(JSON.stringify({
    type: 'terminal-input',
    sessionName,
    data: `python3 -c 'for i in range(${LINE_COUNT}): print(f"{i:03d}")'\n`,
  }));
  const expected = Array.from({ length: LINE_COUNT }, (_, index) => String(index).padStart(3, '0'));
  await waitFor(
    () => expected.every((line) => numberedLines(capturePane(sessionName)).includes(line)),
    `${ownerKey} pane history`,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  return { client, expected };
}

beforeAll(async () => {
  if (!tmuxAvailable) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  apiPort = await freePort();
  wsPort = await freePort();
  apiServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  await startWsServer();
}, 40_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  await stopWsServer();
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  try { execFileSync('tmux', dashboardTmuxArgs('kill-server'), { stdio: 'ignore' }); } catch { /* */ }
  rmSync(dataDir, { recursive: true, force: true });
});

describe.runIf(tmuxAvailable)('dashboard terminal CSI S through WebSocket and xterm (#1979)', () => {
  it('keeps dashboard overrides isolated, idempotent, and alternate-screen safe', async () => {
    const beforeDefaultOverrides = defaultTmuxOverrides();

    const fixed = await createAndFill(fixedOwner, fixedSession);
    expect(CSI_S.test(fixed.client.raw())).toBe(false);
    const firstOverrides = execFileSync('tmux', dashboardTmuxArgs(
      'show-options', '-gv', 'terminal-overrides',
    ), { encoding: 'utf8' });
    expect(firstOverrides.split(/[\n,]/u).map((entry) => entry.trim())
      .filter((entry) => entry === 'xterm*:indn@')).toHaveLength(1);
    expect(firstOverrides).not.toContain('smcup@');
    expect(firstOverrides).not.toContain('rmcup@');

    const second = await createAndFill(secondOwner, secondSession);
    const secondOverrides = execFileSync('tmux', dashboardTmuxArgs(
      'show-options', '-gv', 'terminal-overrides',
    ), { encoding: 'utf8' });
    expect(secondOverrides).toBe(firstOverrides);
    expect(defaultTmuxOverrides()).toBe(beforeDefaultOverrides);
    second.client.socket.close();

    const alternateScreenRows = await renderTerminalBytes([
      `PRIMARY${ESC}[?1049hALTERNATE${ESC}[?1049l`,
    ], { cols: COLS, rows: ROWS, scrollback: 1_000 });
    expect(alternateScreenRows.join('\n')).toContain('PRIMARY');
    expect(alternateScreenRows.join('\n')).not.toContain('ALTERNATE');

    const partialRegionRows = await renderPayload(Buffer.from(
      `111\r\n222\r\n333\r\n444\r\n555${ESC}[2;4r${ESC}[4;1H777\n${ESC}[r`,
    ).toString('base64'));
    expect(partialRegionRows).toContain('777');
    fixed.client.socket.close();
    await once(fixed.client.socket, 'close');
    await stopWsServer();
    await startWsServer();
    const restored = await connectRenderedClient();
    restored.socket.send(JSON.stringify({
      type: 'terminal-create',
      cols: COLS,
      rows: ROWS,
      requestId: 'restored',
      ownerKey: fixedOwner,
    }));
    await waitFor(
      () => restored.frames.some((frame) => frame.event === 'created' && frame.data?.sessionName === fixedSession),
      'cold restored reservation',
    );
    restored.socket.send(JSON.stringify({
      type: 'terminal-attach', sessionName: fixedSession, cols: COLS, rows: ROWS,
    }));
    await waitFor(
      () => restored.frames.some((frame) => frame.event === 'attached' && frame.data?.sessionName === fixedSession),
      'cold restored attachment',
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    const captureRows = numberedLines(capturePane(fixedSession));
    expect(captureRows).toEqual(expect.arrayContaining(fixed.expected));
    const scrollbackFrame = restored.frames.find((frame) => {
      if (frame.channel !== 'terminal' || frame.event !== 'data' || !frame.data?.data) return false;
      return Buffer.from(frame.data.data, 'base64').toString('utf8').includes('000');
    });
    expect(scrollbackFrame?.data?.data).toBeTypeOf('string');
    const replayRows = await renderPayload(scrollbackFrame!.data!.data!);
    const visibleRows = numberedLines((await restored.renderedRows()).join('\n'));
    expect([...replayRows, ...visibleRows.filter((row) => !replayRows.includes(row))]).toEqual(captureRows);
  }, 60_000);
});
