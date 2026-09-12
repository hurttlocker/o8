import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '@/app/api/panel/operator-defaults/route';
import { buildOrchestratorSendPayload } from '@/components/desktop/thoughts/use-orchestrator-stream/send-payload';
import { resolveOrchestratorTurnOptions } from '@/components/desktop/thoughts/use-orchestrator-stream/resolve-turn-options';
import { prepareOrchestratorTurn } from '@/components/desktop/thoughts/use-orchestrator-stream/turn-option-resolution';
import {
  THOUGHTS_OPERATOR_DEFAULTS_FALLBACK,
  type OrchestratorBackendSetting,
  type ThoughtsOperatorDefaults,
} from '@/components/desktop/thoughts/operator-defaults';
import {
  composerBackendTurnOverride,
  resolveFreshComposerTurnOptions,
} from '@/components/desktop/thoughts/useBackendSwitchChoice';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-orchestrator-model-attribution-'));
const repoPath = join(dataDir, 'repo');
const token = 'orchestrator-model-attribution-token';
const sockets = new Set<WebSocket>();
let apiServer: Server;
let wsProcess: ChildProcess;
let apiPort = 0;
let wsPort = 0;
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

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}: ${serverOutput.slice(-2_000)}`);
}

async function persistDefaults(orchestratorModel: string, orchestratorBackend: 'claude' | 'codex') {
  const response = await POST(new Request('http://127.0.0.1/api/panel/operator-defaults', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orchestratorModel, orchestratorBackend }),
  }));
  expect(response.ok).toBe(true);
}

async function submitComposerTurn(
  socket: WebSocket,
  threadId: string,
  capturedModel: string,
  capturedBackend: OrchestratorBackendSetting,
) {
  let displayedModel = capturedModel;
  let displayedBackend = capturedBackend;
  let displayedDefaults: ThoughtsOperatorDefaults = THOUGHTS_OPERATOR_DEFAULTS_FALLBACK;
  const backendSourceRef = { current: 'default' as const };
  const controller = new AbortController();
  const turnOptions = await resolveOrchestratorTurnOptions({
    model: capturedModel,
    backend: composerBackendTurnOverride(capturedBackend),
    resolveTurnOptions: (signal) => resolveFreshComposerTurnOptions({
      repoPath,
      backend: capturedBackend,
      backendSourceRef,
      setBackend: (value) => { displayedBackend = typeof value === 'function' ? value(displayedBackend) : value; },
      setModel: (value) => { displayedModel = typeof value === 'function' ? value(displayedModel) : value; },
      setOperatorDefaults: (value) => { displayedDefaults = typeof value === 'function' ? value(displayedDefaults) : value; },
    }, signal),
  }, controller.signal);
  if (!turnOptions) throw new Error('Composer turn option resolution was cancelled.');
  const turn = prepareOrchestratorTurn('reply deterministically', turnOptions);
  socket.send(buildOrchestratorSendPayload({
    repoPath,
    threadId,
    clientMessageId: `${threadId}-client-message`,
    wireMessage: turn.wireMessage,
    displayMessage: turn.displayMessage,
    permissionMode: turn.permissionMode,
    orchestrationMode: turn.orchestrationMode,
    model: turn.model,
    backend: turn.backend,
  }));
  const historyPath = join(dataDir, 'chat-history', `${threadId}.json`);
  await waitFor(() => {
    try {
      const history = JSON.parse(readFileSync(historyPath, 'utf8')) as { messages?: Array<{ role?: string; model?: string; content?: string }> };
      return history.messages?.some((entry) => entry.role === 'assistant' && entry.content === 'deterministic assistant reply') ?? false;
    } catch {
      return false;
    }
  }, 'persisted assistant attribution');
  const history = JSON.parse(readFileSync(historyPath, 'utf8')) as { messages: Array<{ role: string; model?: string }> };
  return {
    displayedModel,
    displayedBackend,
    recordedModel: history.messages.find((entry) => entry.role === 'assistant')?.model,
  };
}

beforeAll(async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/panel/operator-defaults')) {
      return GET(new Request(`http://127.0.0.1${url}`));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }));
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  const fakeCodex = join(dataDir, 'fake-codex.mjs');
  writeFileSync(fakeCodex, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('codex-cli 0.130.0'); process.exit(0); }
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-thread' }));
console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'deterministic assistant reply' } }));
`);
  chmodSync(fakeCodex, 0o755);
  apiPort = await freePort();
  wsPort = await freePort();
  apiServer = createServer((request, response) => {
    if (request.url === '/api/setup/identity') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ configured: false }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  apiServer.listen(apiPort, '127.0.0.1');
  await once(apiServer, 'listening');
  wsProcess = execFile(process.execPath, ['--import=./scripts/register-server-only-stub.mjs', '--import=tsx', 'src/ws-server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_CODEX_BIN: fakeCodex,
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { serverOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { serverOutput += String(chunk); });
  await waitFor(() => serverOutput.includes('WebSocket server listening'), 'ws-server startup');
}, 30_000);

afterAll(async () => {
  for (const socket of sockets) socket.close();
  if (wsProcess?.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  if (apiServer?.listening) await new Promise<void>((resolve) => apiServer.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('orchestrator model attribution through the real WebSocket turn handler', () => {
  it('records the freshly resolved default on the next real WebSocket turn', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    await once(socket, 'open');

    await persistDefaults('gpt-5.6-sol', 'codex');
    const first = await submitComposerTurn(socket, `thoughts-model-attribution-a-${Date.now()}`, 'gpt-5.6-sol', 'codex');
    expect(first).toMatchObject({ displayedModel: 'gpt-5.6-sol', displayedBackend: 'codex', recordedModel: 'gpt-5.6-sol' });

    await persistDefaults('gpt-5.6-terra', 'codex');
    const second = await submitComposerTurn(socket, `thoughts-model-attribution-b-${Date.now()}`, 'gpt-5.6-sol', 'codex');
    expect(second).toMatchObject({ displayedModel: 'gpt-5.6-terra', displayedBackend: 'codex', recordedModel: 'gpt-5.6-terra' });
  }, 30_000);
});
