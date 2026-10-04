import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { McpToolResult } from '@/lib/mcp/operator-handlers/shared';

vi.mock('@/lib/skeleton/autoscan', () => ({ triggerScan: vi.fn(), triggerScanIfStale: vi.fn(), startChangePolling: vi.fn(), stopChangePolling: vi.fn() }));
vi.mock('@/lib/runtimes/shared/auth-detect', async (original) => ({
  ...await original<typeof import('@/lib/runtimes/shared/auth-detect')>(),
  assertRuntimeDispatchable: vi.fn(async () => undefined),
}));
vi.mock('@/lib/runtimes/shared/dispatch-readiness', () => ({ ensureDispatchBackendReady: vi.fn(async () => ({ ready: true })) }));
vi.mock('@/lib/worktree/storage-telemetry', async (original) => ({
  ...await original<typeof import('@/lib/worktree/storage-telemetry')>(),
  measureHostVolume: vi.fn(async () => ({ accountingStatus: 'observed', probePath: '/', availableBytes: 90_000_000_000, freeBytes: 90_000_000_000, totalBytes: 100_000_000_000, error: null })),
}));
vi.mock('@/lib/analytics/server', () => ({ emitProductEvent: vi.fn() }));
vi.mock('@/lib/realtime/publisher', () => ({ publishRealtimeMutation: vi.fn() }));
vi.mock('@/lib/orchestrator/capacity-snapshots', () => ({ capturePacketCapacitySnapshot: vi.fn(async () => undefined) }));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-prepared-dispatch-')));
const dataDir = join(root, 'data');
const repoPath = join(root, 'repo');
const origin = join(root, 'origin.git');
mkdirSync(dataDir); mkdirSync(repoPath);
const git = (...args: string[]) => execFileSync('git', ['-C', repoPath, ...args], { stdio: 'pipe' });
execFileSync('git', ['init', '-q', '--bare', origin]);
git('init', '-q', '-b', 'main');
writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
git('add', 'README.md');
git('-c', 'user.name=o8 test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
git('remote', 'add', 'origin', origin); git('push', '-u', 'origin', 'main');
execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
for (const [key, value] of Object.entries({ O8_DATA_DIR: dataDir, CORTEX_IDE_DATA_DIR: dataDir,
  CORTEX_IDE_DB_PATH: join(dataDir, 'cortex-ide.db'), O8_OPERATOR_MCP_PROFILE: 'full',
  O8_SKIP_PRELAUNCH_TYPECHECK: '1', O8_APFS_DEPENDENCY_IMAGES: '0', O8_WORKER_SANDBOX: '0',
  O8_CRASH_SURVIVABLE_WORKERS: '0', O8_CODEX_BIN: join(root, 'codex'),
  CORTEX_IDE_OWNED_CODEX_ROOT: join(dataDir, 'owned-codex'), O8_TEST_PROVIDER_CAPTURE: join(root, 'starts.jsonl') })) vi.stubEnv(key, value);
writeFileSync(join(root, 'codex'), `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 1.0.0'); process.exit(0); }
fs.appendFileSync(process.env.O8_TEST_PROVIDER_CAPTURE, JSON.stringify({pid: process.pid, argv: process.argv.slice(2)}) + String.fromCharCode(10));
console.log(JSON.stringify({type: 'thread.started', thread_id: 'fixture-thread-' + process.pid}));
setInterval(() => {}, 1000);
`); chmodSync(join(root, 'codex'), 0o755);
const token = 'prepared-dispatch-operator-fixture';
writeFileSync(join(dataDir, 'ws-token'), token);
const setupRoute = await import('@/app/api/setup/agent/route');
const missionRoute = await import('@/app/api/orchestrator/create-mission/route');
const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
const mcpRoute = await import('@/app/api/mcp/route');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb, getSqlite } = await import('@/lib/db');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
let port = 0;
let dropDispatchResponse = false;
const dispatchBodies: string[] = [];

const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}),
    });
    const gate = panelGateMiddleware(request);
    if (req.url === '/api/orchestrator/dispatch') dispatchBodies.push(body);
    const response = gate.status !== 200 ? gate
      : req.url === '/api/mcp' ? await mcpRoute.POST(request)
      : req.url === '/api/orchestrator/dispatch' ? await dispatchRoute.POST(request)
      : req.url === '/api/setup/agent' ? await setupRoute.POST(request)
      : req.url === '/api/orchestrator/create-mission' ? await missionRoute.POST(request)
      : new Response('Unknown fixture route', { status: 404 });
    if (req.url === '/api/orchestrator/dispatch' && dropDispatchResponse) {
      dropDispatchResponse = false; res.destroy(); return;
    }
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
const contract = {
  version: 1 as const,
  requirements: [{ id: 'R1', source: 'Explicit task.', expectedBehavior: 'One packet receives the sealed contract.', productionPath: 'create_mission -> createMission -> worker', verification: 'Registered HTTP fixture.' }],
  smallestRoute: [{ path: 'src/task.ts', requirements: ['R1'], reason: 'Smallest complete implementation.' }],
  processConstraints: [{ id: 'P1', source: 'Stay within the task.', expectedBehavior: 'No unrelated changes.', verification: 'Review the diff.' }],
  exclusions: ['No candidate comparison.'],
};
async function rpc(method: string, params?: Record<string, unknown>, authenticated = true) {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: response.status, body: await response.json() };
}
type Reply = { result: McpToolResult & { tools?: Array<{ name: string; description: string }> }; error?: unknown };
let client: ChildProcess;
let sequence = 0;
const pending = new Map<number, (reply: Reply) => void>();
function clientRpc(method: string, params?: Record<string, unknown>): Promise<Reply> {
  const id = ++sequence;
  return new Promise(resolve => {
    pending.set(id, resolve);
    client.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function call(name: string, args: Record<string, unknown>) {
  const reply = await clientRpc('tools/call', { name, arguments: args });
  expect(reply.error).toBeUndefined();
  return reply.result;
}
const starts = () => { try { return readFileSync(join(root, 'starts.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length; } catch { return 0; } };
function payload(result: McpToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content[0]; if (content.type !== 'text') throw new Error('Expected text receipt.');
  return JSON.parse(content.text);
}
const create = (extra: Record<string, unknown> = {}) => call('create_mission', {
  repoPath, runtime: 'codex', model: MODEL_IDS.raw.openAiGpt61Sol, requestedEffort: 'medium', dispatch: false,
  issues_inline: [{ title: 'Implement one sealed task', body: 'Owned fixture.' }], sealedTaskContract: contract, ...extra,
});
const count = () => (getSqlite().prepare('SELECT COUNT(*) AS count FROM missions').get() as { count: number }).count;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  writeFileSync(join(dataDir, 'api-port'), String(port));
  const { buildToolRegistry, resetToolSpinePortIdentityForTests } = await import('@/lib/mcp/tool-spine/build');
  resetToolSpinePortIdentityForTests();
  const registry = buildToolRegistry(repoPath, { profile: 'full' });
  const operator = registry.entries.find(entry => entry.id === 'builtin:operator')!.config;
  if (operator.type !== 'stdio') throw new Error('Expected installed operator stdio seam.');
  client = spawn(operator.command, operator.args ?? [], { cwd: repoPath,
    env: { ...process.env, ...operator.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  client.stdout!.on('data', chunk => {
    buffer += chunk.toString(); let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); } catch { /* Startup output. */ }
    }
  });
  payload(await call('o8_setup', { action: 'open', path: repoPath }));
}, 30_000);
afterAll(async () => {
  const { getOwnedCodexFleetAdditions, interruptOwnedCodexSession } = await import('@/lib/codex/owned');
  for (const agent of (await getOwnedCodexFleetAdditions({ fresh: true })).agents) await interruptOwnedCodexSession(agent.sessionKey);
  client.kill('SIGTERM');
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

async function cortexCatalog() {
  const { buildToolRegistry } = await import('@/lib/mcp/tool-spine/build');
  const config = buildToolRegistry(repoPath, { profile: 'full' }).entries.find(entry => entry.id === 'builtin:cortex')!.config;
  if (config.type !== 'stdio') throw new Error('Expected Cortex stdio seam.');
  const child = spawn(config.command, config.args ?? [], { cwd: repoPath,
    env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    let reply: Reply | undefined; let buffer = '';
    child.stdout!.on('data', chunk => {
      buffer += chunk.toString(); let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try { const value = JSON.parse(line); if (value.id === 1) reply = value; } catch { /* Startup output. */ }
      }
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    await vi.waitFor(() => expect(reply).toBeDefined(), { timeout: 15_000 });
    return reply!.result.tools!;
  } finally { child.kill('SIGTERM'); }
}

it('advertises the prepared-mission action in the actual full catalog and Codex fleet prompt', async () => {
  const tools = (await clientRpc('tools/list')).result.tools!;
  expect(tools.find(tool => tool.name === 'dispatch_mission')?.description).toContain('dispatch:false');
  expect(tools.find(tool => tool.name === 'dispatch_mission')?.description).not.toContain('USE THIS RARELY');
  const generic = (await cortexCatalog()).find(tool => tool.name === 'cortex_launch_agent');
  expect(generic?.description).toContain('new task');
  expect(generic?.description).toContain('dispatch_mission');
  const { buildCodexOrchestratorPrompt } = await import('@/lib/lane/codex-orchestrator-session');
  const prompt = buildCodexOrchestratorPrompt(repoPath, 'Complete the task.', { toolProfile: 'full', orchestrationMode: 'fleet' });
  expect(prompt).toContain('dispatch_mission({missionId:');
  expect(prompt).toContain('Do not launch a new worker to dispatch an existing mission');
  for (const profile of ['propose', 'solo', 'fable-solo'] as const) {
    const scoped = buildCodexOrchestratorPrompt(repoPath, 'Complete the task.', { toolProfile: profile });
    expect(scoped).not.toContain('dispatch_mission({missionId:');
  }
});

it('dispatches the advertised prepared mission unchanged through the authenticated registered client exactly once', async () => {
  const created = payload(await create());
  expect(created.packets).toHaveLength(1); expect(starts()).toBe(0);
  closeDb();
  const prepared = readMissionRegistryEntry(created.missionId)!.mission.packets[0];
  expect(prepared).toMatchObject({ queueState: 'held', taskContract: contract });
  const routing = Object.fromEntries(Object.entries(prepared.workerRouting!).filter(([key]) => key !== 'decidedAt'));
  dropDispatchResponse = true;
  const dispatched = payload(await call('dispatch_mission', { missionId: created.missionId }));
  expect(dispatched.dispatched).toBe(1);
  expect(dispatched.replayed).toBe(true);
  expect(dispatchBodies.length).toBeGreaterThan(1);
  expect(new Set(dispatchBodies).size).toBe(1);
  await vi.waitFor(() => expect(starts()).toBe(1), { timeout: 15_000 });
  closeDb();
  const saved = readMissionRegistryEntry(created.missionId)!.mission;
  expect(saved.packets).toHaveLength(1);
  expect(saved.packets[0]).toMatchObject({ id: prepared.id, taskContract: contract, workerRouting: routing });
  const { listLanes } = await import('@/lib/lane/registry');
  const lane = listLanes().find(entry => entry.packetId === prepared.id)!;
  expect(lane.sessionKey).toMatch(/^codex-owned:/);
  expect(count()).toBe(1);
  expect((getSqlite().prepare('SELECT COUNT(*) AS count FROM lanes').get() as { count: number }).count).toBe(1);
  const owned = JSON.parse(readFileSync(join(dataDir, 'owned-codex', lane.sessionKey!.slice('codex-owned:'.length), 'session.json'), 'utf8'));
  expect(owned.model).toBe(MODEL_IDS.raw.openAiGpt61Sol); expect(owned.effort).toBe('medium');
  const capture = JSON.parse(readFileSync(join(root, 'starts.jsonl'), 'utf8').trim());
  expect(capture.argv.join(' ')).toContain(JSON.stringify(contract));
  const changed = await fetch(`http://127.0.0.1:${port}/api/orchestrator/dispatch`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...JSON.parse(dispatchBodies[0]), runtime: 'claude-code' }),
  });
  expect(changed.status).toBe(409);
  payload(await call('dispatch_mission', { missionId: created.missionId }));
  expect(starts()).toBe(1); expect(count()).toBe(1);
}, 40_000);

it('refuses unavailable profiles, foreign or malformed targets, and anonymous calls without effects', async () => {
  const before = starts();
  for (const profile of ['dogfood', 'propose', 'worker']) {
    vi.stubEnv('O8_OPERATOR_MCP_PROFILE', profile);
    expect((await clientRpc('tools/list')).result.tools!.some(tool => tool.name === 'dispatch_mission')).toBe(false);
    expect((await call('dispatch_mission', {})).isError).toBe(true);
  }
  vi.stubEnv('O8_OPERATOR_MCP_PROFILE', 'full');
  expect(payload(await call('dispatch_mission', { missionId: 'mission-foreign-fixture' }))).toMatchObject({ error: expect.any(String) });
  expect((await call('dispatch_mission', { runtime: 'invalid-runtime' })).isError).toBe(true);
  expect((await rpc('tools/call', { name: 'dispatch_mission', arguments: {} }, false)).status).toBe(401);
  const { mintPacketWorkerToken } = await import('@/lib/auth/packet-worker-token');
  const packetId = (getSqlite().prepare('SELECT packet_id FROM lanes').get() as { packet_id: string }).packet_id;
  const denied = await fetch(`http://127.0.0.1:${port}/api/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${mintPacketWorkerToken(packetId)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'dispatch_mission', arguments: {} } }),
  });
  expect(denied.status).toBe(403);
  expect(starts()).toBe(before); expect(count()).toBe(1);
});
