import { execFile, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  claudeInstalled: true,
  claudeAuthenticated: true,
  codexInstalled: true,
  codexAuthenticated: true,
  evalCalls: [] as string[],
}));

const defaultPlannerInfo = {
  available: true,
  engine: 'claude',
  model: 'claude-opus-4-8',
  effort: 'high',
  tools: [{ name: 'o8_status', parameters: { type: 'object', properties: {} } }],
};

vi.mock('@/lib/mcp/o8-webview-client', () => ({
  O8WebviewClient: class {
    async evalJs(code: string) {
      testState.evalCalls.push(code);
      if (code.includes('A.text.plannerInfo')) {
        const info = code.includes('gpt-5.6-sol')
          ? { ...defaultPlannerInfo, engine: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' }
          : defaultPlannerInfo;
        return { result: JSON.stringify({ state: 'done', info }) };
      }
      return {
        result: JSON.stringify({
          state: 'done',
          result: { status: 'done', text: 'The desktop planner answered.' },
        }),
      };
    }
  },
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: async () => ({
    statuses: {
      claude: {
        installed: testState.claudeInstalled,
        authenticated: testState.claudeAuthenticated,
      },
      codex: {
        installed: testState.codexInstalled,
        authenticated: testState.codexAuthenticated,
      },
    },
  }),
}));

const dataDir = mkdtempSync(join(tmpdir(), 'o8-symon-text-wire-'));
const token = 'symon-text-wire-token';
let apiServer: Server;
let wsProcess: ChildProcess;
let apiPort = 0;
let wsPort = 0;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('missing test port'));
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The real ws-server is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('ws-server did not become healthy');
}

beforeAll(async () => {
  process.env.CORTEX_IDE_DATA_DIR = dataDir;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  apiPort = await freePort();
  wsPort = await freePort();

  const { POST: mintTextSession } = await import('@/app/api/mobile/symon/text-session/route');
  const { POST: runTextTurn } = await import('@/app/api/mobile/symon/text-turn/route');
  apiServer = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    if (url.pathname === '/api/mobile/symon/text-session' && request.method === 'POST') {
      const routeResponse = await mintTextSession(new NextRequest(url, {
        method: 'POST',
        headers: request.headers as HeadersInit,
        body,
      }));
      response.writeHead(routeResponse.status, Object.fromEntries(routeResponse.headers.entries()));
      response.end(Buffer.from(await routeResponse.arrayBuffer()));
      return;
    }
    if (url.pathname === '/api/mobile/symon/text-turn' && request.method === 'POST') {
      const routeResponse = await runTextTurn(new NextRequest(url, {
        method: 'POST',
        headers: request.headers as HeadersInit,
        body,
      }));
      response.writeHead(routeResponse.status, Object.fromEntries(routeResponse.headers.entries()));
      response.end(Buffer.from(await routeResponse.arrayBuffer()));
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
  await waitForHealth(wsPort);
}, 30_000);

afterAll(async () => {
  if (wsProcess && wsProcess.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.CORTEX_IDE_DATA_DIR;
});

beforeEach(() => {
  testState.claudeInstalled = true;
  testState.claudeAuthenticated = true;
  testState.codexInstalled = true;
  testState.codexAuthenticated = true;
  testState.evalCalls.length = 0;
});

async function mint(model?: string) {
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/mobile/symon/text-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ workspaceMode: 'o8', currentRoute: '/mobile/ask', ...(model ? { model } : {}) }),
  });
  return {
    response,
    body: await response.json() as {
      session: { sessionId: string; model: string; effort: string; engine: string };
    },
  };
}

describe('Symon text-first say loop wire', () => {
  it('binds an available public model override through mint and the real ws spawn seam', async () => {
    const { response, body: minted } = await mint('codex-sol-xhigh');
    expect(response.status).toBe(200);
    expect(minted.session).toMatchObject({ model: 'gpt-5.6-sol', effort: 'xhigh', engine: 'codex' });
    testState.evalCalls.length = 0;

    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    await once(socket, 'open');
    const frames: Array<Record<string, unknown>> = [];
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`missing text done: ${JSON.stringify(frames)}`)), 10_000);
      socket.on('message', (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        if (frame.channel !== 'symon') return;
        frames.push(frame);
        if (frame.type === 'symon-text-done') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    socket.send(JSON.stringify({
      channel: 'symon',
      type: 'symon-text-turn',
      sessionId: minted.session.sessionId,
      turnId: 'turn-wire-1',
      text: 'What is the current status?',
    }));
    await done;
    socket.close();

    expect(frames.map((frame) => frame.type)).toEqual([
      'symon-text-status',
      'symon-text-delta',
      'symon-text-done',
    ]);
    for (const frame of frames) {
      expect(frame).not.toHaveProperty('event');
      expect(frame).not.toHaveProperty('data');
    }
    expect(frames).toContainEqual(expect.objectContaining({
      channel: 'symon',
      type: 'symon-text-delta',
      sessionId: minted.session.sessionId,
      turnId: 'turn-wire-1',
      delta: 'The desktop planner answered.',
    }));
    expect(frames.at(-1)).toEqual(expect.objectContaining({
      channel: 'symon',
      type: 'symon-text-done',
      status: 'done',
    }));
    const spawnEval = testState.evalCalls.find((code) => code.includes('A.text.runTurn'));
    expect(spawnEval).toContain('"engine":"codex"');
    expect(spawnEval).toContain('"model":"gpt-5.6-sol"');
    expect(spawnEval).toContain('"effort":"xhigh"');
  });

  it('falls back to the live default for omitted, unknown, and unavailable selections', async () => {
    const omitted = await mint();
    expect(omitted.response.status).toBe(200);
    expect(omitted.body.session).toMatchObject({
      engine: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    const unknown = await mint('gpt-5.6-sol');
    expect(unknown.response.status).toBe(200);
    expect(unknown.body.session).toMatchObject({
      engine: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
    });

    testState.codexAuthenticated = false;
    const unavailable = await mint('codex-sol-xhigh');
    expect(unavailable.response.status).toBe(200);
    expect(unavailable.body.session).toMatchObject({
      engine: 'claude',
      model: 'claude-opus-4-8',
      effort: 'high',
    });
  });
});
