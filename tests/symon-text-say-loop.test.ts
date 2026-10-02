import { execFile, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { WebSocket } from 'ws';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  claudeInstalled: true,
  claudeAuthenticated: true,
  codexInstalled: true,
  codexAuthenticated: true,
  evalCalls: [] as string[],
  terminal: null as 'error' | 'interrupted' | null,
  automatic: false,
  evaluate: null as ((code: string) => string) | null,
  turnReplies: [] as Array<{ method: string; turnId: string; state: string }>,
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
      if (testState.evaluate) return { result: testState.evaluate(code) };
      if (code.includes('A.text.plannerInfo')) {
        const info = testState.automatic
          ? { ...defaultPlannerInfo, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true }
          : code.includes('gpt-6.1-sol')
          ? { ...defaultPlannerInfo, engine: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }
          : defaultPlannerInfo;
        return { result: JSON.stringify({ state: 'done', info }) };
      }
      if (testState.terminal) return {
        result: JSON.stringify({
          state: testState.terminal === 'error' ? 'error' : 'done',
          detail: 'fixture terminal failure',
          result: { status: testState.terminal, model: 'gpt-5.6-sol', effort: 'high', text: '' },
        }),
      };
      return {
        result: JSON.stringify({
          state: 'done',
          result: {
            status: 'done',
            text: 'The desktop planner answered.',
            activeMachine: { id: 'macbook', displayName: 'MacBook' },
          },
        }),
      };
    }
  },
}));

vi.mock('@/lib/runtimes/shared/auth-detect', () => {
  const getSnapshot = async () => ({
    statuses: {
      claude: {
        installed: testState.claudeInstalled,
        ready: testState.claudeAuthenticated,
      },
      codex: {
        installed: testState.codexInstalled,
        ready: testState.codexAuthenticated,
      },
    },
  });
  return {
    getRuntimeAuthSnapshot: getSnapshot,
    getRuntimeAuthSnapshotForClaudeCarrier: getSnapshot,
  };
});

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
  const { POST: runTextTurn, DELETE: interruptTextTurn } = await import('@/app/api/mobile/symon/text-turn/route');
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
    if (url.pathname === '/api/mobile/symon/text-turn' && (request.method === 'POST' || request.method === 'DELETE')) {
      const route = request.method === 'DELETE' ? interruptTextTurn : runTextTurn;
      const routeResponse = await route(new NextRequest(url, {
        method: request.method,
        headers: request.headers as HeadersInit,
        body,
      }));
      const reply = await routeResponse.text();
      testState.turnReplies.push({ method: request.method, turnId: JSON.parse(body.toString()).turnId, state: JSON.parse(reply).state });
      response.writeHead(routeResponse.status, Object.fromEntries(routeResponse.headers.entries()));
      response.end(reply);
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
  testState.terminal = null;
  testState.automatic = false;
  testState.evaluate = null;
  testState.turnReplies.length = 0;
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
      session: {
        sessionId: string;
        model: string;
        effort: string;
        engine: string;
        activeMachine: { id: string; displayName: string };
      };
    },
  };
}

describe('Symon text-first say loop wire', () => {
  it('binds an available public model override through mint and the real ws spawn seam', async () => {
    const { response, body: minted } = await mint('codex-sol-xhigh');
    expect(response.status).toBe(200);
    expect(minted.session).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh', engine: 'codex' });
    expect(minted.session.activeMachine).toEqual({ id: 'local', displayName: 'This Mac' });
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
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      activeMachine: { id: 'macbook', displayName: 'MacBook' },
    }));
    expect(frames[0]).toEqual(expect.objectContaining({
      type: 'symon-text-status',
      activeMachine: { id: 'local', displayName: 'This Mac' },
    }));
    const spawnEval = testState.evalCalls.find((code) => code.includes('A.text.runTurn'));
    expect(spawnEval).toContain('"engine":"codex"');
    expect(spawnEval).toContain('"model":"gpt-6.1-sol"');
    expect(spawnEval).toContain('"effort":"xhigh"');
  });

  it('uses the native default for omitted or unknown selections and refuses unavailable pins', async () => {
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
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.body.session).toBeUndefined();
  });
});

it.each(['error', 'interrupted'] as const)('reports fallback metadata on WS %s and binds the next turn', async (status) => {
  testState.automatic = true;
  testState.terminal = status;
  const { body: minted } = await mint();
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  await once(socket, 'open');
  const sendTurn = (turnId: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('missing terminal frame')), 10_000);
    const receive = (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      if (frame.type !== 'symon-text-done' || frame.turnId !== turnId) return;
      clearTimeout(timer);
      socket.off('message', receive);
      resolve(frame);
    };
    socket.on('message', receive);
    socket.send(JSON.stringify({ channel: 'symon', type: 'symon-text-turn',
      sessionId: minted.session.sessionId, turnId, text: 'Hello' }));
  });
  try {
    expect(await sendTurn('terminal-first')).toMatchObject({
      status: status === 'error' ? 'failed' : 'interrupted', model: 'gpt-5.6-sol', effort: 'high',
      ...(status === 'error' ? { detail: 'fixture terminal failure' } : {}),
    });
    testState.terminal = null;
    testState.evalCalls.length = 0;
    expect(await sendTurn('terminal-next')).toMatchObject({ status: 'done', model: 'gpt-5.6-sol', effort: 'high' });
    const spawnEval = testState.evalCalls.find((code) => code.includes('A.text.runTurn'));
    expect(spawnEval).toContain('"model":"gpt-5.6-sol"');
    expect(spawnEval).toContain('"allowDefaultFallback":false');
  } finally {
    socket.close();
  }
});

it('reconciles actual phone Stop before spawning a queued next turn', async () => {
  let finishNative!: (result: Record<string, unknown>) => void;
  const nativePending = new Promise<Record<string, unknown>>((resolve) => { finishNative = resolve; });
  const bindingsAtSpawn: Array<Record<string, unknown> | undefined> = [];
  const nativeRun = vi.fn(async (_prompt: string, sessionId: string, turnId: string, _planner: unknown) => {
    bindingsAtSpawn.push((JSON.parse(readFileSync(join(dataDir, 'symon-text-sessions.json'), 'utf8')) as Array<Record<string, unknown>>)
      .find((session) => session.sessionId === sessionId));
    return turnId === 'stop-first' ? nativePending : { status: 'done', model: 'gpt-5.6-sol', effort: 'high', text: 'Next answer.' };
  });
  const nativeInterrupt = vi.fn(async () => true);
  const context = { window: { __o8SymonAgent: { text: {
    plannerInfo: async () => ({ ...defaultPlannerInfo, engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true }),
    runTurn: nativeRun,
    interruptTurn: nativeInterrupt,
  } } } };
  testState.evaluate = (code) => runInNewContext(code, context);
  const { body: minted } = await mint();
  const sessionId = minted.session.sessionId;
  const sessionOnDisk = () => (JSON.parse(readFileSync(join(dataDir, 'symon-text-sessions.json'), 'utf8')) as Array<Record<string, unknown>>)
    .find((session) => session.sessionId === sessionId);
  const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
  await once(socket, 'open');
  const frames: Array<Record<string, unknown>> = [];
  socket.on('message', (raw) => { frames.push(JSON.parse(String(raw))); });
  const send = (type: string, turnId: string) => socket.send(JSON.stringify({ channel: 'symon', type, sessionId, turnId, text: 'Hello' }));
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 8_000;
    while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  };
  const terminal = () => frames.filter((frame) => frame.type === 'symon-text-done');
  try {
    send('symon-text-turn', 'stop-first');
    await waitFor(() => nativeRun.mock.calls.length === 1);
    expect(nativeRun.mock.calls[0][3]).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high', allowDefaultFallback: true });
    send('symon-text-interrupt', 'stop-first');
    await waitFor(() => testState.turnReplies.some((reply) => reply.method === 'DELETE' && reply.state === 'done'));
    send('symon-text-interrupt', 'stop-first'); // duplicate Stop must not redeliver cancellation
    send('symon-text-turn', 'stop-next'); // queue while the native turn is still blocked
    // The actual POST poll window must expire while native completion remains held.
    await waitFor(() => testState.turnReplies.some((reply) => reply.method === 'POST' && reply.turnId === 'stop-first' && reply.state === 'pending'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(terminal(), 'DELETE acknowledgement must not fabricate native completion').toEqual([]);
    expect(nativeRun).toHaveBeenCalledTimes(1);
    expect(sessionOnDisk()).toMatchObject({ model: 'gpt-6.1-sol', allowDefaultFallback: true });
    finishNative({ status: 'interrupted', model: 'gpt-5.6-sol', effort: 'high', text: '' });
    await waitFor(() => terminal().length === 2);
    expect(terminal().map(({ turnId, status, model, effort }) => ({ turnId, status, model, effort }))).toEqual([
      { turnId: 'stop-first', status: 'interrupted', model: 'gpt-5.6-sol', effort: 'high' },
      { turnId: 'stop-next', status: 'done', model: 'gpt-5.6-sol', effort: 'high' },
    ]);
    expect(sessionOnDisk()).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    expect(nativeRun.mock.calls[1][3]).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    expect(bindingsAtSpawn[1]).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', allowDefaultFallback: false });
    send('symon-text-turn', 'stop-first');
    send('symon-text-turn', 'stop-next');
    send('symon-text-interrupt', 'stop-first');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(terminal()).toHaveLength(2);
    expect(nativeRun).toHaveBeenCalledTimes(2);
    expect(nativeInterrupt).toHaveBeenCalledTimes(1);
    expect(testState.turnReplies.filter((reply) => reply.method === 'DELETE')).toHaveLength(1);
    expect(frames.filter((frame) => frame.type === 'symon-text-delta')).toHaveLength(1);
  } finally {
    finishNative({ status: 'interrupted', model: 'gpt-5.6-sol', effort: 'high', text: '' });
    socket.close();
  }
}, 20_000);
