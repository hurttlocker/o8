import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { MODEL_IDS } from '@/lib/models';
import type { LaunchOptions, RuntimeId } from '@/lib/runtimes/types';
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
// Capture only the provider start boundary. Real dispatch, provisioning, prompt
// construction and lane persistence still execute; no provider is contacted.
const launches = vi.hoisted(() => vi.fn(async (input: LaunchOptions) => ({
  ok: true, sessionKey: `fixture:${input.packetId}`, note: 'Captured provider start without inference.',
})));
vi.mock('@/lib/runtimes', async (original) => {
  const actual = await original<typeof import('@/lib/runtimes')>();
  return { ...actual, getRuntime: (id: RuntimeId) => {
    const runtime = actual.getRuntime(id);
    return runtime ? { ...runtime, launch: launches } : undefined;
  } };
});

const root = realpathSync(mkdtempSync(join(tmpdir(), 'o8-mission-retry-')));
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
  O8_WORKTREE_ROOT: join(dataDir, 'worktrees'),
  O8_SKIP_PRELAUNCH_TYPECHECK: '1', O8_APFS_DEPENDENCY_IMAGES: '0' })) vi.stubEnv(key, value);
const token = 'mission-retry-operator-fixture';
writeFileSync(join(dataDir, 'ws-token'), token);
const setupRoute = await import('@/app/api/setup/agent/route');
const missionRoute = await import('@/app/api/orchestrator/create-mission/route');
const dispatchRoute = await import('@/app/api/orchestrator/dispatch/route');
const resetRoute = await import('@/app/api/orchestrator/reset-packet/route');
const mcpRoute = await import('@/app/api/mcp/route');
const { panelGateMiddleware } = await import('@/middleware');
const { closeDb, getSqlite } = await import('@/lib/db');
const { readMissionRegistryEntry } = await import('@/lib/orchestrator/mission-registry');
const { WorktreeManager } = await import('@/lib/worktree/manager');
let port = 0;
const dispatches: Promise<unknown>[] = [];
const creationBodies: Record<string, unknown>[] = [];
let dropCreationResponse = false;
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = new NextRequest(`http://127.0.0.1:${port}${req.url}`, {
      method: req.method, headers: req.headers as Record<string, string>, ...(body ? { body } : {}),
    });
    const gate = panelGateMiddleware(request);
    if (req.url === '/api/orchestrator/create-mission') creationBodies.push(JSON.parse(body));
    const dispatch = req.url === '/api/orchestrator/dispatch' && gate.status === 200 ? dispatchRoute.POST(request) : null;
    if (dispatch) dispatches.push(dispatch);
    const response = gate.status !== 200 ? gate
      : req.url === '/api/mcp' ? await mcpRoute.POST(request)
      : req.url === '/api/setup/agent' ? await setupRoute.POST(request)
      : req.url === '/api/orchestrator/create-mission' ? await missionRoute.POST(request)
      : req.url === '/api/orchestrator/reset-packet' ? await resetRoute.POST(request)
      : dispatch ? await dispatch
      : new Response('Unknown fixture route', { status: 404 });
    if (req.url === '/api/orchestrator/create-mission' && dropCreationResponse) {
      dropCreationResponse = false; res.destroy(); return;
    }
    res.writeHead(response.status, { 'Content-Type': 'application/json' }); res.end(await response.text());
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })); }
});
async function rpc(method: string, params?: Record<string, unknown>) {
  const response = await fetch(`http://127.0.0.1:${port}/api/mcp`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return response.json();
}
async function call(name: string, args: Record<string, unknown>) {
  return (await rpc('tools/call', { name, arguments: args })).result as McpToolResult;
}
function payload(result: McpToolResult) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content[0]; if (content.type !== 'text') throw new Error('Expected text receipt.');
  return JSON.parse(content.text);
}
const create = (extra: Record<string, unknown> = {}) => call('create_mission', {
  repoPath, runtime: 'codex', requestedModel: MODEL_IDS.raw.openAiGpt61Sol, requestedEffort: 'medium', dispatch: false,
  issues_inline: [{ title: 'Implement a retry-safe task', body: 'Owned fixture.' }], ...extra,
});
const count = () => (getSqlite().prepare('SELECT COUNT(*) AS count FROM missions').get() as { count: number }).count;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
  writeFileSync(join(dataDir, 'api-port'), String(port));
  payload(await call('o8_setup', { action: 'open', path: repoPath }));
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await Promise.allSettled(dispatches);
  await new Promise<void>(resolve => server.close(() => resolve()));
  closeDb(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true });
});

it('advertises an explicit exact-retry key on the registered MCP entry point', async () => {
  const tool = (await rpc('tools/list')).result.tools.find((entry: { name: string }) => entry.name === 'create_mission');
  expect(tool.inputSchema.properties.idempotencyKey).toMatchObject({ type: 'string', minLength: 1 });
});

it('replays one persisted inline mission across concurrent calls and a database reopen', async () => {
  const before = count();
  const args = { idempotencyKey: 'inline-retry' };
  const first = payload(await create(args));
  expect(first.replayed).not.toBe(true);
  const [second, third] = await Promise.all([create(args), create(args)]);
  for (const result of [second, third]) expect(payload(result)).toMatchObject({ missionId: first.missionId, packets: first.packets, replayed: true });
  closeDb();
  expect(payload(await create(args))).toMatchObject({ missionId: first.missionId, replayed: true });
  expect(count()).toBe(before + 1);
  expect(readMissionRegistryEntry(first.missionId)?.mission.packets.map(packet => packet.id)).toEqual(first.packets.map((packet: { id: string }) => packet.id));
  const conflict = await create({ ...args, constraints: 'Different task instructions' });
  expect(conflict.isError).toBe(true);
  expect(JSON.stringify(conflict)).toContain('409');
  expect(count()).toBe(before + 1);
});

it('keeps distinct explicit keys and omitted keys as separate deliberate missions', async () => {
  const before = count();
  const results = [];
  for (const args of [{ idempotencyKey: 'separate-a' }, { idempotencyKey: 'separate-b' }, {}, {}]) results.push(payload(await create(args)));
  expect(new Set(results.map(result => result.missionId)).size).toBe(4);
  expect(count()).toBe(before + 4);
});

it('returns ids before slow provisioning finishes and never dispatches an exact replay again', async () => {
  const before = count();
  const beforeDispatches = dispatches.length;
  const beforeLaunches = launches.mock.calls.length;
  let packetId = '';
  let retry: Promise<McpToolResult> | undefined;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = WorktreeManager.prototype.create;
  const provision = vi.spyOn(WorktreeManager.prototype, 'create').mockImplementation(async function (this: InstanceType<typeof WorktreeManager>, ...args) {
    await held;
    return original.apply(this, args);
  });
  try {
    const started = performance.now();
    const first = payload(await create({ dispatch: true, idempotencyKey: 'slow-provision' }));
    expect(performance.now() - started).toBeLessThan(3000);
    packetId = first.packets[0].id;
    expect(first.missionId).toEqual(expect.any(String));
    expect(first.packets).toHaveLength(1);
    expect(first.dispatch).toMatchObject({ queued: true });
    await vi.waitFor(() => expect(provision).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const saved = readMissionRegistryEntry(first.missionId)!.mission;
    expect(saved.packets[0].id).toBe(first.packets[0].id);
    let replay: McpToolResult | undefined;
    retry = create({ dispatch: true, idempotencyKey: 'slow-provision' });
    void retry.then(result => { replay = result; });
    await vi.waitFor(() => expect(replay).toBeDefined(), { timeout: 2000 });
    const second = payload(replay!);
    expect(second).toMatchObject({ missionId: first.missionId, replayed: true });
    expect(count()).toBe(before + 1);
    // Allow a queued accidental second dispatch request to reach the HTTP server.
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(dispatches).toHaveLength(beforeDispatches + 1);
    expect(provision).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await retry;
    await Promise.allSettled(dispatches);
  }
  expect(launches.mock.calls.length).toBe(beforeLaunches + 1);
  closeDb();
  const { findLaneByPacket } = await import('@/lib/lane/registry');
  const lane = findLaneByPacket(packetId);
  expect(lane?.worktreePath).toBeTruthy();
  expect(existsSync(lane!.worktreePath!)).toBe(true);
}, 30_000);

it('reuses the exact create body after a lost HTTP response without duplicating the mission', async () => {
  const before = count();
  const bodyStart = creationBodies.length;
  dropCreationResponse = true;
  const created = payload(await create({ idempotencyKey: 'lost-response' }));
  expect(created.missionId).toEqual(expect.any(String));
  expect(creationBodies.slice(bodyStart)).toHaveLength(2);
  expect(creationBodies[bodyStart + 1]).toEqual(creationBodies[bodyStart]);
  closeDb();
  expect(payload(await create({ idempotencyKey: 'lost-response' })).missionId).toBe(created.missionId);
  expect(count()).toBe(before + 1);
});

it('forwards the same key for GitHub issues through the real issue-loader process and HTTP route', async () => {
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, '#!/usr/bin/env node\nconsole.log(JSON.stringify({number: 123, title: "Fixture issue", body: "Owned fixture.", url: "https://example.invalid/issues/123"}));\n');
  chmodSync(gh, 0o755);
  const oldPath = process.env.PATH;
  vi.stubEnv('PATH', `${bin}:${oldPath}`);
  try {
    const before = count();
    const args = { issues_inline: undefined, issues: ['123'], idempotencyKey: 'github-retry' };
    const first = payload(await create(args));
    closeDb();
    expect(payload(await create(args))).toMatchObject({ missionId: first.missionId, packets: first.packets, replayed: true });
    expect(count()).toBe(before + 1);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
  }
});

it.each(['', '   ', 42])('rejects a malformed key before allocating a mission: %j', async idempotencyKey => {
  const before = count();
  expect((await create({ idempotencyKey })).isError).toBe(true);
  expect(count()).toBe(before);
});


it.each([
  ['retry_packet', 'in-process'], ['reset_packet', 'in-process'],
  ['retry_packet', 'filesystem'], ['reset_packet', 'filesystem'],
])('returns a bounded busy receipt for %s while a real %s lock stays held', async (tool, mode) => {
  const created = payload(await create());
  const packetId = created.packets[0].id;
  const { withLockedState, readOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
  const expectedState = readOrchestratorControlPlaneState().packets.find(packet => packet.id === packetId)!.status;
  const registryBefore = readMissionRegistryEntry(created.missionId)?.mission.packets[0].status;
  const statePath = join(dataDir, 'orchestrator-state.json');
  const lockDir = `${statePath}.lock`;
  let release!: () => void;
  let owner: Promise<unknown> | undefined;
  if (mode === 'in-process') {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    owner = withLockedState(async () => { entered(); await held; });
    await ready;
  } else {
    // Live filesystem ownership without an in-process FIFO slot models the
    // other server process. The actual filesystem lock/acquirer stays real.
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, 'holder.json'), JSON.stringify({ pid: process.pid, at: Date.now(), token: 'busy-fixture' }));
    release = () => rmSync(lockDir, { recursive: true, force: true });
  }
  const before = readFileSync(statePath, 'utf8');
  const lockBefore = readFileSync(join(lockDir, 'holder.json'), 'utf8');
  let pending: Promise<McpToolResult> | undefined;
  try {
    let result: McpToolResult | undefined;
    pending = call(tool, { packetId });
    void pending.then(value => { result = value; });
    await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 3000 });
    expect(result!.isError).toBe(true);
    const content = result!.content[0];
    const error = JSON.parse(content.type === 'text' ? content.text : '');
    expect(error).toMatchObject({ code: 'mission_store_busy', state: expectedState, packetId, retryAfterMs: 1000 });
    expect(readFileSync(statePath, 'utf8')).toBe(before);
    expect(readFileSync(join(lockDir, 'holder.json'), 'utf8')).toBe(lockBefore);
    expect(readMissionRegistryEntry(created.missionId)?.mission.packets[0].status).toBe(registryBefore);
  } finally {
    release();
    await owner;
    await pending;
  }
}, 15_000);
