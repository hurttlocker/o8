import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { mapHistoryMessagesToTranscript } from '@/components/desktop/thoughts/history-transcript';
import type { ComposerWireMode } from '@/lib/orchestrator/composer-wire';
import type { ThinkingEffort } from '@/lib/orchestrator/thinking-effort';
import type { OrchestratorExecutionMode } from '@/lib/orchestrator/types';

const dataDir = mkdtempSync(join(tmpdir(), 'o8-orchestrator-model-attribution-'));
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_DATA_DIR = dataDir;
const originPath = join(dataDir, 'origin.git');
const seedPath = join(dataDir, 'seed');
const repoPath = join(dataDir, 'repo');
const token = 'orchestrator-model-attribution-token';
const promptCapturePath = join(dataDir, 'turn-prompt.txt');
const workerCapturePath = join(dataDir, 'turn-worker.json');
const connectedWorkerHelper = `
  import { writeFileSync } from 'node:fs';
  const repos = (await import('./src/lib/repos/registry.ts')).default;
  const missions = (await import('./src/lib/orchestrator/operator-mission-service.ts')).default;
  const controlPlane = (await import('./src/lib/orchestrator/control-plane.ts')).default;
  const laneRegistry = (await import('./src/lib/lane/registry.ts')).default;
  const runtimeCapabilities = (await import('./src/lib/orchestrator/runtime-capabilities.ts')).default;
  const chatHistory = (await import('./src/lib/llm/chat-history-store.ts')).default;
  await repos.addRepo(process.env.O8_TEST_TARGET_REPO);
  const mission = await missions.createMission({
    issues: [{ number: 2316, title: 'Connected receipt fixture', body: '', url: '' }],
    repoPath: process.env.O8_TEST_TARGET_REPO,
    runtime: 'codex',
    constraints: '',
    orchestratorThreadId: process.env.O8_TEST_THREAD_ID,
    orchestratorTurnId: process.env.O8_TEST_TURN_ID,
  });
  await missions.dispatchMission({ missionId: mission.missionId });
  const packetId = mission.packets[0].id;
  const deadline = Date.now() + 15_000;
  let packet;
  let lane;
  let history;
  let storedTurn;
  let pendingWorkers;
  let receiptWorkers;
  while (Date.now() < deadline) {
    packet = controlPlane.readOrchestratorControlPlaneState().packets.find((row) => row.id === packetId);
    lane = laneRegistry.listLanes(new Set([packetId]))[0];
    history = chatHistory.readPersistedLlmChat(process.env.O8_TEST_THREAD_ID)?.history;
    storedTurn = history?.messages.find((message) => message.id === process.env.O8_TEST_TURN_ID);
    pendingWorkers = history?.pendingTurnWorkers?.[process.env.O8_TEST_TURN_ID];
    receiptWorkers = storedTurn?.receipt?.workers;
    const launchCompleted = Boolean(lane?.sessionKey)
      || Boolean(packet && packet.status !== 'queued' && packet.status !== 'launching');
    const workerLanded = [...(pendingWorkers ?? []), ...(receiptWorkers ?? [])]
      .some((worker) => worker.packetId === packetId);
    if (launchCompleted && workerLanded) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!lane || ![...(pendingWorkers ?? []), ...(receiptWorkers ?? [])].some((worker) => worker.packetId === packetId)) {
    throw new Error(
      'Timed out waiting for the connected worker receipt after launch completion. '
      + 'packet=' + (packet?.status ?? 'missing') + ' lane=' + (lane?.status ?? 'missing'),
    );
  }
  writeFileSync(process.env.O8_TEST_CONNECTED_WORKER_FILE, JSON.stringify({
    packetId,
    runtime: lane.runtime,
    model: lane.model ?? runtimeCapabilities.getRuntimeCapability(lane.runtime).defaultModel,
    turnId: process.env.O8_TEST_TURN_ID,
    packetThreadId: packet?.orchestratorThreadId,
    packetTurnId: packet?.orchestratorTurnId,
    landedVia: (pendingWorkers ?? []).some((worker) => worker.packetId === packetId)
      ? 'pending buffer'
      : 'direct merge',
    immediatePending: pendingWorkers,
    immediateWorkers: receiptWorkers,
  }));
  process.exit(0);
`;
const sockets = new Set<WebSocket>();
let apiServer: Server;
let wsProcess: ChildProcess;
let apiPort = 0;
let wsPort = 0;
let serverOutput = '';
const { readPersistedLlmChat } = await import('@/lib/llm/chat-history-store');

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
  options: {
    thinkingEffort?: ThinkingEffort;
    orchestrationMode?: OrchestratorExecutionMode;
    pickedMode?: ComposerWireMode;
    message?: string;
  } = {},
) {
  let displayedModel = capturedModel;
  let displayedBackend = capturedBackend;
  let displayedDefaults: ThoughtsOperatorDefaults = THOUGHTS_OPERATOR_DEFAULTS_FALLBACK;
  const backendSourceRef = { current: 'default' as const };
  const controller = new AbortController();
  const turnOptions = await resolveOrchestratorTurnOptions({
    model: capturedModel,
    backend: composerBackendTurnOverride(capturedBackend),
    thinkingEffort: options.thinkingEffort,
    orchestrationMode: options.orchestrationMode,
    pickedMode: options.pickedMode,
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
  const turn = prepareOrchestratorTurn(options.message ?? 'reply deterministically', turnOptions);
  if (options.message === 'dispatch connected receipt worker') rmSync(workerCapturePath, { force: true });
  socket.send(buildOrchestratorSendPayload({
    repoPath,
    threadId,
    clientMessageId: `${threadId}-client-message`,
    wireMessage: turn.wireMessage,
    displayMessage: turn.displayMessage,
    permissionMode: turn.permissionMode,
    orchestrationMode: turn.orchestrationMode,
    pickedMode: turn.pickedMode,
    thinkingEffort: turn.thinkingEffort,
    model: turn.model,
    backend: turn.backend,
  }));
  const historyPath = join(dataDir, 'chat-history', `${threadId}.json`);
  await waitFor(() => {
    try {
      const history = JSON.parse(readFileSync(historyPath, 'utf8')) as { messages?: Array<{ role?: string; content?: string; receipt?: unknown }> };
      return history.messages?.some((entry) => (
        entry.role === 'assistant'
        && entry.content === ''
        && entry.receipt !== undefined
      )) ?? false;
    } catch {
      return false;
    }
  }, 'receipt-only assistant row before reply text');
  await waitFor(() => {
    try {
      const history = JSON.parse(readFileSync(historyPath, 'utf8')) as { messages?: Array<{ role?: string; model?: string; content?: string; receipt?: unknown }> };
      return history.messages?.some((entry) => (
        entry.role === 'assistant'
        && entry.content === 'deterministic assistant reply'
        && (options.thinkingEffort === undefined || entry.receipt !== undefined)
      )) ?? false;
    } catch {
      return false;
    }
  }, 'persisted assistant attribution', options.message === 'dispatch connected receipt worker' ? 90_000 : 20_000);
  const history = JSON.parse(readFileSync(historyPath, 'utf8')) as { messages: Array<{ id: string; role: string; model?: string }> };
  const assistant = history.messages.find((entry) => entry.role === 'assistant');
  const persisted = readPersistedLlmChat(threadId);
  const transcript = mapHistoryMessagesToTranscript(
    persisted?.history.messages ?? [],
    persisted?.history.pendingTurnWorkers,
  );
  return {
    displayedModel,
    displayedBackend,
    recordedModel: assistant?.model,
    recordedMessageId: assistant?.id,
    wirePrompt: readFileSync(promptCapturePath, 'utf8'),
    worker: existsSync(workerCapturePath)
      ? JSON.parse(readFileSync(workerCapturePath, 'utf8')) as {
          packetId: string;
          runtime: string;
          model: string;
          turnId: string;
          packetThreadId: string;
          packetTurnId: string;
          landedVia: 'pending buffer' | 'direct merge';
          immediatePending?: unknown;
          immediateWorkers?: unknown;
        }
      : null,
    threadId,
    receipt: transcript.find((entry) => entry.role === 'assistant')?.receipt,
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
  execFileSync('git', ['init', '--bare', originPath], { stdio: 'pipe' });
  execFileSync('git', ['clone', originPath, seedPath], { stdio: 'pipe' });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: seedPath, stdio: 'pipe' });
  writeFileSync(join(seedPath, 'README.md'), 'turn receipt fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: seedPath });
  execFileSync('git', ['-c', 'user.name=o8-test', '-c', 'user.email=test@o8.test', 'commit', '-qm', 'fixture'], { cwd: seedPath });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: seedPath, stdio: 'pipe' });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: originPath, stdio: 'pipe' });
  execFileSync('git', ['clone', originPath, repoPath], { stdio: 'pipe' });
  writeFileSync(join(dataDir, 'ws-token'), `${token}\n`, { mode: 0o600 });
  const fakeCodex = join(dataDir, 'fake-codex.mjs');
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
if (process.argv.includes('--version')) { console.log('codex-cli 0.130.0'); process.exit(0); }
const prompt = process.argv.join('\\n');
if (process.env.O8_TEST_TURN_PROMPT_FILE && prompt.includes('orchestratorThreadId:')) {
  writeFileSync(process.env.O8_TEST_TURN_PROMPT_FILE, prompt);
}
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fake-codex-thread' }));
if (prompt.includes('dispatch connected receipt worker')) {
  const threadId = prompt.match(/orchestratorThreadId: "([^"]+)"/)?.[1];
  const turnId = prompt.match(/orchestratorTurnId: "([^"]+)"/)?.[1];
  const result = spawnSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    '--input-type=module',
    '--eval',
    process.env.O8_TEST_CONNECTED_WORKER_HELPER,
  ], {
    cwd: process.env.O8_TEST_SOURCE_ROOT,
    env: { ...process.env, O8_TEST_THREAD_ID: threadId, O8_TEST_TURN_ID: turnId },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(result.status ?? 1);
  }
}
await new Promise((resolve) => setTimeout(resolve, 150));
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
    if (request.url === '/api/setup/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
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
      O8_TEST_TURN_PROMPT_FILE: promptCapturePath,
      O8_TEST_CONNECTED_WORKER_FILE: workerCapturePath,
      O8_TEST_CONNECTED_WORKER_HELPER: connectedWorkerHelper,
      O8_TEST_SOURCE_ROOT: process.cwd(),
      O8_TEST_TARGET_REPO: repoPath,
      O8_DEFAULT_DISPATCH_RUNTIME: 'codex',
      O8_SUBSCRIPTION_PROFILE: 'both',
      O8_SKIP_PRELAUNCH_TYPECHECK: '1',
      O8_WORKER_SANDBOX: '0',
      O8_CRASH_SURVIVABLE_WORKERS: '0',
      O8_WORKTREE_ROOT: join(dataDir, 'worktrees'),
      O8_APFS_COW_WORKSPACES: '0',
      O8_APFS_DEPENDENCY_IMAGES: '0',
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
  delete process.env.CORTEX_IDE_DATA_DIR;
  delete process.env.O8_DATA_DIR;
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

  it('persists the effective model, effort, and mode through the desktop history reader', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    await once(socket, 'open');

    await persistDefaults('gpt-5.6-sol', 'codex');
    const turn = await submitComposerTurn(
      socket,
      `thoughts-turn-receipt-${Date.now()}`,
      'gpt-5.6-sol',
      'codex',
      { thinkingEffort: 'high', orchestrationMode: 'fleet', pickedMode: 'multitask' },
    );

    expect(turn.receipt).toEqual({
      leadModel: 'gpt-5.6-sol',
      effort: 'high',
      mode: 'multitask',
    });
    expect(turn.wirePrompt).toContain(`orchestratorThreadId: "${turn.threadId}"`);
    expect(turn.wirePrompt).toContain(`orchestratorTurnId: "${turn.recordedMessageId}"`);
  }, 30_000);

  it('persists the effective Fusion override and the picked Solo mode', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    await once(socket, 'open');

    await persistDefaults('gpt-5.6-sol', 'codex');
    const turn = await submitComposerTurn(
      socket,
      `thoughts-turn-receipt-override-${Date.now()}`,
      'gpt-5.6-sol',
      'codex',
      { thinkingEffort: 'high', orchestrationMode: 'fusion', pickedMode: 'solo' },
    );

    expect(turn.receipt).toEqual({
      leadModel: 'gpt-5.6-sol',
      effort: 'high',
      mode: 'fusion',
      pickedMode: 'solo',
    });
  }, 30_000);

  it('carries the sent turn ids through a real mission dispatch into the worker receipt', async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(token)}`);
    sockets.add(socket);
    await once(socket, 'open');

    await persistDefaults('gpt-5.6-sol', 'codex');
    const turn = await submitComposerTurn(
      socket,
      `thoughts-turn-worker-receipt-${Date.now()}`,
      'gpt-5.6-sol',
      'codex',
      {
        thinkingEffort: 'high',
        orchestrationMode: 'fleet',
        pickedMode: 'multitask',
        message: 'dispatch connected receipt worker',
      },
    );

    const expectedWorker = {
      packetId: turn.worker?.packetId,
      runtime: 'codex',
      model: turn.worker?.model,
    };
    expect(turn.worker).toMatchObject({
      ...expectedWorker,
      turnId: turn.recordedMessageId,
      packetThreadId: turn.threadId,
      packetTurnId: turn.recordedMessageId,
    });
    expect(turn.worker?.landedVia).toMatch(/^(pending buffer|direct merge)$/);
    expect([turn.worker?.immediatePending, turn.worker?.immediateWorkers]).toContainEqual([expectedWorker]);
    expect(turn.receipt?.workers).toEqual([expectedWorker]);
    console.log(`[turn-receipt-test] worker row landed via ${turn.worker?.landedVia}`);
  }, 120_000);
});
