import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/claude-code/warm-repl-pool', () => ({
  askClaudeWarm: vi.fn(async () => ''),
  prewarmClaudeRepl: vi.fn(),
}));

interface CliResult { exitCode: number | null; stdout: string; stderr: string }
interface LeadCliReceipt {
  lead: {
    id: string;
    threadId: string;
    status: string;
    routing: { backend: string; model: string; effort: string };
  };
  admittedTurnId?: string;
  latestTurn: { id: string; status: string } | null;
  cursor: number;
}

const testHome = mkdtempSync(path.join(os.tmpdir(), 'o8-lead-handoff-home-'));
const dataDir = path.join(testHome, '.o8');
const repoPath = path.join(testHome, 'repo');
const remotePath = path.join(testHome, 'remote.git');
const briefPath = path.join(testHome, 'brief.json');
const fakeCodex = path.join(testHome, '.local', 'bin', 'codex');
const argsPath = path.join(testHome, 'codex-args.jsonl');
const workerCapturePath = path.join(testHome, 'lead-worker.json');
const reviewCapturePath = path.join(testHome, 'lead-review.json');
const dispatchDebugPath = path.join(testHome, 'lead-dispatch-debug.json');
const token = 'lead-handoff-operator-token-0123456789abcdef';
const workerToken = 'lead-handoff-worker-token-0123456789abcdef';
const originalEnv = {
  HOME: process.env.HOME,
  O8_DATA_DIR: process.env.O8_DATA_DIR,
  CORTEX_IDE_DATA_DIR: process.env.CORTEX_IDE_DATA_DIR,
  O8_CODEX_BIN: process.env.O8_CODEX_BIN,
  O8_TEST_LEAD_ARGS: process.env.O8_TEST_LEAD_ARGS,
  O8_CRASH_SURVIVABLE_WORKERS: process.env.O8_CRASH_SURVIVABLE_WORKERS,
  O8_STORAGE_RESERVE_RATIO: process.env.O8_STORAGE_RESERVE_RATIO,
  O8_STORAGE_RESERVE_FLOOR_GB: process.env.O8_STORAGE_RESERVE_FLOOR_GB,
  O8_CLAUDE_CODE_BIN: process.env.O8_CLAUDE_CODE_BIN,
  O8_TEST_DISPATCH_HELPER: process.env.O8_TEST_DISPATCH_HELPER,
  O8_TEST_REVIEW_HELPER: process.env.O8_TEST_REVIEW_HELPER,
  O8_TEST_CONNECTED_WORKER_FILE: process.env.O8_TEST_CONNECTED_WORKER_FILE,
  O8_TEST_REVIEW_FILE: process.env.O8_TEST_REVIEW_FILE,
  O8_TEST_DISPATCH_DEBUG_FILE: process.env.O8_TEST_DISPATCH_DEBUG_FILE,
  O8_TEST_SOURCE_ROOT: process.env.O8_TEST_SOURCE_ROOT,
  O8_TEST_TARGET_REPO: process.env.O8_TEST_TARGET_REPO,
};

mkdirSync(dataDir, { recursive: true });
mkdirSync(repoPath, { recursive: true });
writeFileSync(path.join(dataDir, 'ws-token'), `${token}\n`, 'utf8');
writeFileSync(path.join(dataDir, 'worker-token'), `${workerToken}\n`, 'utf8');
process.env.HOME = testHome;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.O8_CODEX_BIN = fakeCodex;
process.env.O8_TEST_LEAD_ARGS = argsPath;
process.env.O8_CRASH_SURVIVABLE_WORKERS = '1';
process.env.O8_STORAGE_RESERVE_RATIO = '0.000001';
process.env.O8_STORAGE_RESERVE_FLOOR_GB = '0.001';
process.env.O8_CLAUDE_CODE_BIN = fakeCodex;

const leadRoute = await import('@/app/api/orchestrator/lead/route');
const { __resetLeadRuntimeForTests, getLeadStatus, queueLeadReviewContinuation } = await import('@/lib/orchestrator/lead-lifecycle');
const { closeDb, getSqlite } = await import('@/lib/db');
const { panelGateMiddleware } = await import('@/middleware');
const { readOrchestratorBackendSessionId, readOrchestratorThreadMessages } = await import('@/lib/mobile/orchestrator-thread-history');

let apiServer: Server | null = null;
let apiPort = 0;
let wsPort = 0;
let wsProcess: ChildProcess | null = null;
let wsOutput = '';

const dispatchWorkerHelper = `
  import { execFileSync } from 'node:child_process';
  import { existsSync, writeFileSync } from 'node:fs';
  import path from 'node:path';
  const repos = (await import('./src/lib/repos/registry.ts')).default;
  const missions = (await import('./src/lib/orchestrator/operator-mission-service.ts')).default;
  const laneRegistry = (await import('./src/lib/lane/registry.ts')).default;
  const readiness = await fetch('http://127.0.0.1:' + process.env.O8_API_PORT + '/api/setup/status', {
    headers: { authorization: 'Bearer ' + process.env.O8_API_TOKEN },
  });
  console.log('[lead-fixture] readiness=' + readiness.status + ' port=' + process.env.O8_API_PORT);
  await repos.addRepo(process.env.O8_TEST_TARGET_REPO);
  const mission = await missions.createMission({
    issues: [{ number: 2541, title: 'Persistent lead worker fixture', body: 'Write the deterministic proof file.', url: '' }],
    repoPath: process.env.O8_TEST_TARGET_REPO,
    runtime: 'codex',
    constraints: '',
    orchestratorThreadId: process.env.O8_TEST_THREAD_ID,
    orchestratorTurnId: process.env.O8_TEST_TURN_ID,
  });
  await missions.dispatchMission({ missionId: mission.missionId });
  const packetId = mission.packets[0].id;
  const deadline = Date.now() + 15000;
  let lane;
  while (Date.now() < deadline) {
    lane = laneRegistry.findLaneByPacket(packetId);
    if (lane?.sessionKey) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!lane?.sessionKey) throw new Error('Worker did not launch for packet ' + packetId);
  const proofPath = path.join(lane.worktreePath, 'lead-worker-proof.txt');
  const proofDeadline = Date.now() + 10_000;
  while (Date.now() < proofDeadline && !existsSync(proofPath)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!existsSync(proofPath)) throw new Error('Worker did not produce its proof file for packet ' + packetId);
  const workerHead = execFileSync('git', ['-C', lane.worktreePath, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
  if (workerHead !== 'test: add persistent lead proof') throw new Error('Worker proof was not committed.');
  writeFileSync(process.env.O8_TEST_CONNECTED_WORKER_FILE, JSON.stringify({
    packetId,
    laneId: lane.id,
    sessionKey: lane.sessionKey,
    worktreePath: lane.worktreePath,
    threadId: process.env.O8_TEST_THREAD_ID,
    turnId: process.env.O8_TEST_TURN_ID,
  }));
  process.exit(0);
`;

const reviewWorkerHelper = `
  import { execFileSync } from 'node:child_process';
  import { readFileSync, writeFileSync } from 'node:fs';
  const missions = (await import('./src/lib/orchestrator/operator-mission-service.ts')).default;
  const worker = JSON.parse(readFileSync(process.env.O8_TEST_CONNECTED_WORKER_FILE, 'utf8'));
  if (!worker.packetId || !worker.worktreePath) throw new Error('Review worker binding is missing.');
  const head = execFileSync('git', ['-C', worker.worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const review = await missions.submitPacketReview({
    packetId: worker.packetId,
    approved: true,
    findings: [],
    reviewedHeadSha: head,
  });
  writeFileSync(process.env.O8_TEST_REVIEW_FILE, JSON.stringify({ review }));
`;

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

async function waitForWsOutput(text: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (wsOutput.includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${text}: ${wsOutput.slice(-2_000)}`);
}

function readArgs(): string[][] {
  try {
    return readFileSync(argsPath, 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  } catch { return []; }
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function writeRouteResponse(response: ServerResponse, routeResponse: Response): Promise<void> {
  response.writeHead(routeResponse.status, { 'Content-Type': routeResponse.headers.get('Content-Type') ?? 'application/json' });
  response.end(await routeResponse.text());
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'cli/dist/o8.mjs'), ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        O8_DATA_DIR: dataDir,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_API_PORT: String(apiPort),
        O8_API_TOKEN: token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (exitCode) => resolveRun({ exitCode, stdout, stderr }));
  });
}

async function settled(leadId: string, timeout = '10s'): Promise<LeadCliReceipt> {
  const result = await runCli(['lead', 'wait', leadId, '--timeout', timeout]);
  expect(result.exitCode, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as LeadCliReceipt;
}

function startArgs(key: string): string[] {
  return [
    'lead', 'start', '--repo', repoPath, '--backend', 'codex',
    '--model', 'gpt-5.6-sol', '--effort', 'high', '--brief', briefPath,
    '--idempotency-key', key,
  ];
}

beforeAll(async () => {
  mkdirSync(path.dirname(fakeCodex), { recursive: true });
  execFileSync('git', ['init', '--bare', '-q', remotePath]);
  execFileSync('git', ['init', '-q', '-b', 'main', repoPath]);
  writeFileSync(path.join(repoPath, 'README.md'), 'lead handoff fixture\n');
  execFileSync('git', ['-C', repoPath, 'add', 'README.md']);
  execFileSync('git', ['-C', repoPath, '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local', 'commit', '-qm', 'test: seed lead fixture']);
  execFileSync('git', ['-C', repoPath, 'remote', 'add', 'origin', remotePath]);
  execFileSync('git', ['-C', repoPath, 'push', '-qu', 'origin', 'main']);
  writeFileSync(briefPath, JSON.stringify({
    objective: 'Own this bounded task through worker review and terminal handback.',
    scope: ['The isolated fixture repository.'],
    doneTests: ['The deterministic provider reply is persisted.'],
    nonGoals: ['No production mutation.'],
    budgets: ['No external API spend.'],
    escalationCriteria: ['Escalate only when operator authority is required.'],
  }), 'utf8');
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli 0.145.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { console.log('Logged in'); process.exit(0); }
if (args.includes('--input-format')) process.exit(0);
appendFileSync(process.env.O8_TEST_LEAD_ARGS, JSON.stringify(args) + '\\n');
const prompt = args.at(-1) || '';
const resumeIndex = args.indexOf('resume');
const threadId = resumeIndex < 0 ? 'fixture-persistent-lead-thread' : args[resumeIndex + 1];
console.log(JSON.stringify({ type: 'thread.started', thread_id: threadId }));
if (process.env.O8_WORKER_PACKET_ID) {
  writeFileSync('lead-worker-proof.txt', 'worker returned to persistent lead\\n');
  const commit = spawnSync('git', [
    '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local',
    'add', 'lead-worker-proof.txt',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  if (commit.status !== 0) { console.error(commit.stderr); process.exit(commit.status || 1); }
  const saved = spawnSync('git', [
    '-c', 'user.name=o8 test', '-c', 'user.email=test@o8.local',
    'commit', '-qm', 'test: add persistent lead proof',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  if (saved.status !== 0) { console.error(saved.stderr); process.exit(saved.status || 1); }
}
if (prompt.includes('[fixture:dispatch-worker]')) {
  const turnThreadId = prompt.match(/orchestratorThreadId: "([^"]+)"/)?.[1];
  const turnId = prompt.match(/orchestratorTurnId: "([^"]+)"/)?.[1];
  const result = spawnSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    '--input-type=module', '--eval', process.env.O8_TEST_DISPATCH_HELPER,
  ], {
    cwd: process.env.O8_TEST_SOURCE_ROOT,
    env: { ...process.env, O8_TEST_THREAD_ID: turnThreadId, O8_TEST_TURN_ID: turnId },
    encoding: 'utf8', timeout: 30000,
  });
  writeFileSync(process.env.O8_TEST_DISPATCH_DEBUG_FILE, JSON.stringify(result));
  if (result.status !== 0) {
    console.error(((result.stderr || '') + '\\n' + (result.stdout || '')).slice(-3000));
    process.exit(result.status || 1);
  }
}
if (prompt.includes('reached review-ready')) {
  const packetId = prompt.match(/packet ([^)]+)\\)/)?.[1];
  const result = spawnSync(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs', '--import=tsx',
    '--input-type=module', '--eval', process.env.O8_TEST_REVIEW_HELPER,
  ], {
    cwd: process.env.O8_TEST_SOURCE_ROOT,
    env: { ...process.env, O8_TEST_PACKET_ID: packetId },
    encoding: 'utf8', timeout: 20000,
  });
  if (result.status !== 0) { console.error(result.stderr || result.stdout); process.exit(result.status || 1); }
}
if (prompt.includes('[fixture:hang]')) await new Promise((resolve) => setTimeout(resolve, 5000));
else if (prompt.includes('[fixture:slow-left-2541]') || prompt.includes('reached review-ready')) await new Promise((resolve) => setTimeout(resolve, 350));
console.log(JSON.stringify({ type: 'item.completed', item: { id: 'reply', type: 'agent_message', text: 'offline lead reply' } }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
`, 'utf8');
  chmodSync(fakeCodex, 0o755);
  process.env.O8_TEST_DISPATCH_HELPER = dispatchWorkerHelper;
  process.env.O8_TEST_REVIEW_HELPER = reviewWorkerHelper;
  process.env.O8_TEST_CONNECTED_WORKER_FILE = workerCapturePath;
  process.env.O8_TEST_REVIEW_FILE = reviewCapturePath;
  process.env.O8_TEST_DISPATCH_DEBUG_FILE = dispatchDebugPath;
  process.env.O8_TEST_SOURCE_ROOT = process.cwd();
  process.env.O8_TEST_TARGET_REPO = repoPath;
  execFileSync(process.execPath, [path.join(process.cwd(), 'cli/esbuild.config.mjs')], { cwd: process.cwd(), stdio: 'ignore' });

  apiServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname === '/api/setup/identity') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ configured: false }));
      return;
    }
    if (requestUrl.pathname === '/api/setup/status') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
      return;
    }
    if (requestUrl.pathname !== '/api/orchestrator/lead') { response.writeHead(404).end(); return; }
    const body = await readBody(request);
    const nextRequest = new NextRequest(`http://127.0.0.1${requestUrl.pathname}${requestUrl.search}`, {
      method: request.method,
      headers: request.headers as HeadersInit,
      body: body || undefined,
    });
    await writeRouteResponse(response, request.method === 'GET'
      ? await leadRoute.GET(nextRequest)
      : await leadRoute.POST(nextRequest));
  });
  await new Promise<void>((resolveListen) => apiServer!.listen(0, '127.0.0.1', resolveListen));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('lead fixture server did not bind');
  apiPort = address.port;
  process.env.O8_API_PORT = String(apiPort);
  wsPort = await freePort();
  process.env.O8_WS_PORT = String(wsPort);
  wsProcess = execFile(process.execPath, [
    '--import=./scripts/register-server-only-stub.mjs',
    '--import=tsx',
    'src/ws-server.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      O8_API_PORT: String(apiPort),
      O8_WS_PORT: String(wsPort),
      O8_DEFAULT_DISPATCH_RUNTIME: 'codex',
      O8_SUBSCRIPTION_PROFILE: 'both',
      O8_SKIP_PRELAUNCH_TYPECHECK: '1',
      O8_WORKER_SANDBOX: '0',
      O8_WORKTREE_ROOT: path.join(dataDir, 'worktrees'),
      O8_APFS_COW_WORKSPACES: '0',
      O8_APFS_DEPENDENCY_IMAGES: '0',
      NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    },
  });
  wsProcess.stdout?.on('data', (chunk) => { wsOutput += String(chunk); });
  wsProcess.stderr?.on('data', (chunk) => { wsOutput += String(chunk); });
  await waitForWsOutput('WebSocket server listening');
}, 60_000);

afterAll(async () => {
  __resetLeadRuntimeForTests();
  if (wsProcess?.exitCode === null) {
    wsProcess.kill('SIGTERM');
    await Promise.race([once(wsProcess, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
  await new Promise<void>((resolveClose, reject) => {
    if (!apiServer) return resolveClose();
    apiServer.close((error) => error ? reject(error) : resolveClose());
  });
  closeDb();
  rmSync(testHome, { recursive: true, force: true });
  for (const [key, previous] of Object.entries(originalEnv)) {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

describe('persistent lead handoff real path', () => {
  it('drives actual CLI, authenticated route, provider process, and persisted resume pins', async () => {
    const started = await runCli(startArgs('lead-start-main'));
    expect(started.exitCode, started.stderr).toBe(0);
    const startReceipt = JSON.parse(started.stdout) as LeadCliReceipt;
    const first = await settled(startReceipt.lead.id);
    expect(first.lead).toMatchObject({
      id: startReceipt.lead.id,
      threadId: startReceipt.lead.threadId,
      status: 'completed',
      routing: { backend: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
    });
    const follow = await runCli([
      'lead', 'send', first.lead.id, '--message', 'Continue with the same persistent lead.',
      '--idempotency-key', 'lead-follow-main',
    ]);
    expect(follow.exitCode, follow.stderr).toBe(0);
    await settled(first.lead.id);

    const calls = readArgs();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('model=gpt-5.6-sol');
    expect(calls[0]).toContain('model_reasoning_effort=high');
    expect(calls[1].slice(0, 3)).toEqual(['exec', 'resume', 'fixture-persistent-lead-thread']);
    expect(calls[1]).toContain('model=gpt-5.6-sol');
    expect(calls[1]).toContain('model_reasoning_effort=high');
    expect(readOrchestratorThreadMessages(first.lead.threadId).map((message) => message.role))
      .toEqual(['user', 'assistant', 'user', 'assistant']);

    const repeatedStart = await runCli(startArgs('lead-start-main'));
    expect(repeatedStart.exitCode, repeatedStart.stderr).toBe(0);
    expect((JSON.parse(repeatedStart.stdout) as LeadCliReceipt).lead.id).toBe(first.lead.id);
    expect(readArgs()).toHaveLength(2);

    const duplicate = await runCli([
      'lead', 'send', first.lead.id, '--message', 'Continue with the same persistent lead.',
      '--idempotency-key', 'lead-follow-main',
    ]);
    expect(duplicate.exitCode, duplicate.stderr).toBe(0);
    expect((JSON.parse(duplicate.stdout) as LeadCliReceipt).admittedTurnId)
      .toBe((JSON.parse(follow.stdout) as LeadCliReceipt).admittedTurnId);
    expect(readArgs()).toHaveLength(2);
  }, 20_000);

  it('serializes simultaneous sends and retrieves results after client loss and runtime reset', async () => {
    const current = getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'lead-start-main'`).get() as { id: string };
    const [left, right] = await Promise.all([
      runCli(['lead', 'send', current.id, '--message', '[fixture:slow-left-2541]', '--idempotency-key', 'parallel-left']),
      runCli(['lead', 'send', current.id, '--message', '[fixture:right-2541]', '--idempotency-key', 'parallel-right']),
    ]);
    expect(left.exitCode, left.stderr).toBe(0);
    expect(right.exitCode, right.stderr).toBe(0);
    await settled(current.id);
    const calls = readArgs();
    expect(calls).toHaveLength(4);
    expect(new Set(calls.slice(2).map((args) => args.at(-1)?.includes('[fixture:slow-left-2541]') ? 'left' : 'right')))
      .toEqual(new Set(['left', 'right']));

    const lost = await runCli([
      'lead', 'send', current.id, '--message', 'client may disconnect after admission',
      '--idempotency-key', 'lost-client',
    ]);
    expect(lost.exitCode, lost.stderr).toBe(0);
    await settled(current.id);
    const statusBeforeRestart = getLeadStatus(current.id);
    expect(readOrchestratorBackendSessionId(statusBeforeRestart.lead.threadId, 'codex'))
      .toBe('fixture-persistent-lead-thread');
    const callsBeforeRestart = readArgs().length;
    execFileSync(process.execPath, [
      '--import=./scripts/register-server-only-stub.mjs',
      '--import=tsx',
      '--input-type=module',
      '--eval',
      `const lifecycle = (await import('./src/lib/orchestrator/lead-lifecycle.ts')).default;
       lifecycle.sendLead({ leadId: process.env.O8_TEST_LEAD_ID, message: 'fresh process resume', idempotencyKey: 'fresh-process-resume' });
       const deadline = Date.now() + 10000;
       let cursor = 0;
       while (Date.now() < deadline) {
         const receipt = await lifecycle.waitForLead({ leadId: process.env.O8_TEST_LEAD_ID, afterCursor: cursor, waitMs: 250 });
         cursor = receipt.cursor;
         if (['completed', 'blocked', 'needs_approval', 'failed', 'stopped'].includes(receipt.lead.status)) {
           if (receipt.lead.status !== 'completed') throw new Error('fresh process lead ended ' + receipt.lead.status);
           process.exit(0);
         }
       }
       throw new Error('fresh process lead timed out');`,
    ], {
      cwd: process.cwd(),
      env: { ...process.env, O8_TEST_LEAD_ID: current.id },
      stdio: 'pipe',
      timeout: 15_000,
    });
    expect(readArgs()).toHaveLength(callsBeforeRestart + 1);
    expect(readArgs().filter((args) => args[0] === 'exec').at(-1)?.slice(0, 3))
      .toEqual(['exec', 'resume', 'fixture-persistent-lead-thread']);
    __resetLeadRuntimeForTests();
    const reattached = await runCli(['lead', 'status', current.id]);
    expect(reattached.exitCode, reattached.stderr).toBe(0);
    expect((JSON.parse(reattached.stdout) as LeadCliReceipt).lead.status).toBe('completed');
  }, 20_000);

  it('fails mismatched routing before admission or provider side effects', async () => {
    const lead = getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'lead-start-main'`).get() as { id: string };
    const turnCount = (getSqlite().prepare('SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ?').get(lead.id) as { count: number }).count;
    const callCount = readArgs().length;
    const mismatch = await runCli([
      'lead', 'send', lead.id, '--message', 'must not persist', '--idempotency-key', 'wrong-binding',
      '--thread-id', 'thoughts-other',
    ]);
    expect(mismatch.exitCode).toBe(5);
    expect((getSqlite().prepare('SELECT COUNT(*) AS count FROM orchestrator_lead_turns WHERE lead_id = ?').get(lead.id) as { count: number }).count).toBe(turnCount);
    expect(readArgs()).toHaveLength(callCount);

    const invalid = await runCli(startArgs('invalid-model').map((part) => part === 'gpt-5.6-sol' ? 'claude-opus-5' : part));
    expect(invalid.exitCode).toBe(1);
    expect(getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'invalid-model'`).get()).toBeUndefined();
    expect(readArgs()).toHaveLength(callCount);
  });

  it('preserves an interrupted turn and requires an explicit recovery send', async () => {
    const lead = getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'lead-start-main'`).get() as { id: string };
    const latest = getSqlite().prepare(
      'SELECT id FROM orchestrator_lead_turns WHERE lead_id = ? ORDER BY ordinal DESC LIMIT 1',
    ).get(lead.id) as { id: string };
    getSqlite().prepare(
      `UPDATE orchestrator_lead_turns SET status = 'running', owner_pid = 99999999, finished_at = NULL WHERE id = ?`,
    ).run(latest.id);
    getSqlite().prepare(
      `UPDATE orchestrator_leads SET status = 'running', current_turn_id = ? WHERE id = ?`,
    ).run(latest.id, lead.id);
    const recovered = getLeadStatus(lead.id);
    expect(recovered.lead.status).toBe('blocked');
    expect(recovered.latestTurn?.status).toBe('interrupted');
    const sent = await runCli([
      'lead', 'send', lead.id, '--message', 'Recover explicitly after interruption.',
      '--idempotency-key', 'recover-interrupted',
    ]);
    expect(sent.exitCode, sent.stderr).toBe(0);
    expect((await settled(lead.id)).lead.status).toBe('completed');
  }, 10_000);

  it('dispatches a real worker and returns its production review wake to the same lead', async () => {
    const lead = getSqlite().prepare(
      `SELECT id, thread_id AS threadId FROM orchestrator_leads WHERE start_key = 'lead-start-main'`,
    ).get() as { id: string; threadId: string };
    rmSync(workerCapturePath, { force: true });
    rmSync(reviewCapturePath, { force: true });
    const sent = await runCli([
      'lead', 'send', lead.id, '--message', '[fixture:dispatch-worker]',
      '--idempotency-key', 'dispatch-real-worker',
    ]);
    expect(sent.exitCode, sent.stderr).toBe(0);
    await vi.waitFor(() => expect(existsSync(workerCapturePath)).toBe(true), { timeout: 20_000 });
    const launchedWorker = JSON.parse(readFileSync(workerCapturePath, 'utf8')) as { sessionKey: string };
    const completion = await fetch(`http://127.0.0.1:${wsPort}/supervisor/completed`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ surfaceId: launchedWorker.sessionKey }),
    });
    expect(completion.status).toBe(200);
    expect(await completion.json()).toMatchObject({ ok: true, ingested: true });
    const waited = await runCli(['lead', 'wait', lead.id, '--timeout', '40s']);
    expect(
      waited.exitCode,
      `${waited.stderr}\nstatus:\n${JSON.stringify(getLeadStatus(lead.id))}\nprovider calls:\n${JSON.stringify(readArgs())}\nworker:\n${existsSync(workerCapturePath) ? readFileSync(workerCapturePath, 'utf8') : '(missing)'}\nreview:\n${existsSync(reviewCapturePath) ? readFileSync(reviewCapturePath, 'utf8') : '(missing)'}\nws tail:\n${wsOutput.slice(-8_000)}`,
    ).toBe(0);
    const terminal = JSON.parse(waited.stdout) as LeadCliReceipt;
    expect(
      ['completed', 'needs_approval'],
      `${JSON.stringify(terminal)}\nprovider calls:\n${JSON.stringify(readArgs())}\ndispatch:\n${existsSync(dispatchDebugPath) ? readFileSync(dispatchDebugPath, 'utf8') : '(missing)'}\nws tail:\n${wsOutput.slice(-4_000)}`,
    ).toContain(terminal.lead.status);
    expect(existsSync(workerCapturePath)).toBe(true);
    const worker = JSON.parse(readFileSync(workerCapturePath, 'utf8')) as {
      packetId: string;
      threadId: string;
      turnId: string;
    };
    expect(worker.threadId).toBe(lead.threadId);
    expect(worker.turnId).toBe((JSON.parse(sent.stdout) as LeadCliReceipt).admittedTurnId?.replace('lead-turn-', 'lead-assistant-lead-turn-'));
    expect(existsSync(reviewCapturePath)).toBe(true);
    const review = JSON.parse(readFileSync(reviewCapturePath, 'utf8')) as {
      review: { recorded: boolean };
    };
    expect(review.review.recorded).toBe(true);
    expect(terminal.lead.status).toBe('needs_approval');
    expect(readArgs().filter((args) => args[0] === 'exec').at(-1)?.slice(0, 3))
      .toEqual(['exec', 'resume', 'fixture-persistent-lead-thread']);
  }, 90_000);

  it('persists stop across runtime recovery and never relaunches', async () => {
    const lead = getSqlite().prepare(`SELECT id FROM orchestrator_leads WHERE start_key = 'lead-start-main'`).get() as { id: string };
    const callsBeforeSend = readArgs().length;
    const sent = await runCli([
      'lead', 'send', lead.id, '--message', '[fixture:hang] do not finish', '--idempotency-key', 'stop-hang',
    ]);
    expect(sent.exitCode, sent.stderr).toBe(0);
    await vi.waitFor(() => expect(getLeadStatus(lead.id).lead.status).toBe('running'), { timeout: 2_000 });
    await vi.waitFor(() => expect(readArgs()).toHaveLength(callsBeforeSend + 1), { timeout: 2_000 });
    const callsAtStop = readArgs().length;
    const stopped = await runCli(['lead', 'stop', lead.id, '--reason', 'bounded stop proof']);
    expect(stopped.exitCode, stopped.stderr).toBe(0);
    expect((JSON.parse(stopped.stdout) as LeadCliReceipt).lead.status).toBe('stopped');
    __resetLeadRuntimeForTests();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(getLeadStatus(lead.id).lead.status).toBe('stopped');
    expect(readArgs()).toHaveLength(callsAtStop);
    expect(queueLeadReviewContinuation({
      repoPath,
      packetId: (JSON.parse(readFileSync(workerCapturePath, 'utf8')) as { packetId: string }).packetId,
      laneId: 'lane-after-stop',
      label: 'stopped review return',
    })).toBe(true);
    expect(readArgs()).toHaveLength(callsAtStop);
    const refused = await runCli([
      'lead', 'send', lead.id, '--message', 'must not auto-resume', '--idempotency-key', 'after-stop',
    ]);
    expect(refused.exitCode).toBe(5);
    expect(readArgs()).toHaveLength(callsAtStop);
  }, 10_000);

  it('keeps the new route operator-only and rejects malformed waits without side effects', async () => {
    const worker = panelGateMiddleware(new NextRequest('http://localhost:3001/api/orchestrator/lead', {
      method: 'POST', headers: { authorization: `Bearer ${workerToken}`, 'x-o8-worker-packet-id': 'packet-worker' },
    }));
    expect(worker.status).toBe(403);
    const operator = panelGateMiddleware(new NextRequest('http://localhost:3001/api/orchestrator/lead', {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    }));
    expect(operator.status).toBe(200);

    const countsBefore = getSqlite().prepare(`
      SELECT
        (SELECT COUNT(*) FROM orchestrator_leads) AS leads,
        (SELECT COUNT(*) FROM orchestrator_lead_turns) AS turns,
        (SELECT COUNT(*) FROM orchestrator_lead_events) AS events
    `).get();
    const malformed = await fetch(
      `http://127.0.0.1:${apiPort}/api/orchestrator/lead?leadId=unused&waitMs=1x`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      ok: false,
      error: { code: 'invalid_lead_wait' },
    });
    expect(getSqlite().prepare(`
      SELECT
        (SELECT COUNT(*) FROM orchestrator_leads) AS leads,
        (SELECT COUNT(*) FROM orchestrator_lead_turns) AS turns,
        (SELECT COUNT(*) FROM orchestrator_lead_events) AS events
    `).get()).toEqual(countsBefore);
  });
});
