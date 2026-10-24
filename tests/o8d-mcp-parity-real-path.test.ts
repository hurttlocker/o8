import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compareMcpExchanges, replayMcp, sendRecordedMcp, type RecordedMcpRequest } from '../scripts/lib/mcp-parity';

// Replace external observations only. Middleware, MCP handlers, API routes and persisted state are real.
vi.mock('@clerk/nextjs/server', () => ({ clerkMiddleware: (handler: unknown) => handler }));
vi.mock('@/lib/mcp/o8-webview-client', () => ({ O8WebviewClient: class {
  async screenshot() { return { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==' }; }
} }));
vi.mock('@/lib/runtime/inventory', () => ({ getRuntimeInventorySnapshot: async () => ({ agents: [] }) }));
vi.mock('@/lib/runtimes/shared/auth-detect', () => ({
  getRuntimeAuthSnapshot: async () => ({ statuses: {} }),
  getDispatchableRuntimeAvailability: async () => [],
}));

const directory = process.env.CORTEX_IDE_DATA_DIR!;
const token = 'o8d-fixture-operator-credential';
writeFileSync(join(directory, 'ws-token'), token);
const refusedCredentials = { worker: 'fixture-worker-credential', device: 'fixture-device-credential', spectator: 'fixture-spectator-credential' };
writeFileSync(join(directory, 'worker-token'), refusedCredentials.worker);
for (const [filename, credential] of [['mobile-device-tokens', refusedCredentials.device], ['broadcast-spectator-tokens', refusedCredentials.spectator]]) {
  writeFileSync(join(directory, filename), `${createHash('sha256').update(credential).digest('hex')}\n`);
}
process.env.O8D_MCP_READS = '1';
const { panelGateMiddleware } = await import('@/middleware');
const { mintPluginToken } = await import('@/lib/auth/plugin-token');
const mcp = await import('@/app/api/mcp/route');
const tasks = await import('@/app/api/tasks/route');
const mission = await import('@/app/api/orchestrator/status/route');
const status = await import('@/app/api/operator/status/route');
const defaults = await import('@/app/api/panel/operator-defaults/route');
const repos = await import('@/app/api/panel/repos/route');
const projects = await import('@/app/api/panel/projects/route');
const leases = await import('@/app/api/leases/route');
const { closeDb, getSqlite } = await import('@/lib/db');
const { createLane, setLaneStatus } = await import('@/lib/lane/registry');
const { writeOrchestratorControlPlaneState } = await import('@/lib/orchestrator/control-plane');
const { normalizeOrchestratorMissionState } = await import('@/lib/orchestrator/store');
const children: ChildProcess[] = [];
const seen: Array<{ path: string; body: string; headers: Record<string, string | string[] | undefined> }> = [];
type Handler = (request: NextRequest) => Response | Promise<Response>;
const routes: Record<string, Partial<Record<string, Handler>>> = {
  '/api/mcp': { POST: mcp.POST, GET: mcp.GET, DELETE: mcp.DELETE },
  '/api/tasks': { GET: tasks.GET, POST: tasks.POST },
  '/api/orchestrator/status': { GET: mission.GET },
  '/api/operator/status': { GET: status.GET },
  '/api/panel/operator-defaults': { GET: defaults.GET, POST: defaults.POST },
  '/api/panel/repos': { GET: repos.GET, POST: repos.POST },
  '/api/panel/projects': { GET: projects.GET, POST: projects.POST },
  '/api/leases': { GET: leases.GET, POST: leases.POST },
};
let base = '';
let rust = '';
let records: RecordedMcpRequest[];
let failedSource = '';
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const request = new NextRequest(`${base}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      ...(body.length ? { body } : {}),
    });
    seen.push({ path: request.nextUrl.pathname, body: body.toString(), headers: incoming.headers });
    const gate = panelGateMiddleware(request);
    const handler = routes[request.nextUrl.pathname]?.[request.method];
    const response = gate.status !== 200 ? gate : request.nextUrl.pathname === failedSource
      ? Response.json({ error: 'fixture unavailable' }, { status: 503 })
      : handler ? await handler(request) : new Response(null, { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    outgoing.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"fixture route failed"}');
  }
});

async function call(baseUrl: string, name: string, args: Record<string, unknown> = {}) {
  return sendRecordedMcp(baseUrl, token, { name, body: {
    jsonrpc: '2.0', id: 'fixture', method: 'tools/call', params: { name, arguments: args },
  } });
}
function toolPayload(exchange: Awaited<ReturnType<typeof call>>) {
  return JSON.parse((exchange.body as { result: { content: Array<{ text: string }> } }).result.content[0].text);
}

async function startRust(upstream: string): Promise<string> {
  const binary = process.env.O8D_MCP_TEST_BINARY ?? 'crates/o8d/target/debug/o8d-mcp';
  const child = spawn(binary, ['--experimental-mcp', '--listen', '127.0.0.1:0', '--upstream', upstream], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const [line] = await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw new Error('Rust MCP startup failed'); })]);
  return `http://${JSON.parse(String(line)).listening}`;
}
async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture listener');
  return `http://127.0.0.1:${address.port}`;
}
async function stop(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

beforeAll(async () => {
  if (!process.env.O8D_MCP_TEST_BINARY) {
    await promisify(execFile)('cargo', ['build', '--locked', '--manifest-path', 'crates/o8d/Cargo.toml', '--features', 'experimental-mcp']);
  }
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture listener');
  base = `http://127.0.0.1:${address.port}`;
  process.env.PORT = String(address.port);
  process.env.O8_API_BASE = base;
  writeFileSync(join(directory, 'api-port'), String(address.port));
  const repo = join(directory, 'repo');
  mkdirSync(repo, { recursive: true });
  await promisify(execFile)('git', ['init', '--quiet', repo]);
  writeFileSync(join(directory, 'repos.json'), JSON.stringify({ version: 1, repos: [{
    id: 'fixture-repo', name: 'Fixture', localPath: repo, remoteUrl: null,
    defaultBranch: 'main', isGitRepo: true, createdAt: '2026-01-01T00:00:00.000Z',
  }] }));
  writeFileSync(join(directory, 'projects.json'), JSON.stringify({ activeProjectId: 'fixture-project', projects: [
    { id: 'default', name: 'Workspace', repoPaths: [], createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'fixture-project', name: 'Fixture project', repoPaths: [repo], createdAt: '2026-01-01T00:00:00.000Z' },
  ] }));
  writeOrchestratorControlPlaneState(normalizeOrchestratorMissionState({
    missionId: 'fixture-mission', prompt: 'Fixture mission', summary: 'Recorded mission', runtime: 'codex',
    packets: [{ id: 'fixture-packet', title: 'Queued packet', summary: 'Fixture packet', runtime: 'codex',
      status: 'draft', queueState: 'queued', releaseState: 'pending', dependencyPacketIds: [] }],
  }));
  for (const laneStatus of ['running', 'reviewing', 'failed', 'completed'] as const) {
    const lane = createLane({ repoPath: repo, runtime: 'codex', branch: `fixture/${laneStatus}`,
      label: `Fixture ${laneStatus}`, baseCommit: 'a'.repeat(40) });
    setLaneStatus(lane.id, laneStatus, 'system');
  }
  const leaseResponse = await fetch(`${base}/api/leases`, { method: 'POST', headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ action: 'acquire', resource: 'fixture:mcp-parity',
    owner: { id: 'fixture-owner', label: 'Fixture owner', pid: process.pid }, claimToken: 'fixture-lease-claim-value-0123456789', ttlMs: 86_400_000 }) });
  expect(leaseResponse.status).toBe(200);
  rust = await startRust(base);
  records = JSON.parse(readFileSync('tests/fixtures/mcp-parity/requests.json', 'utf8').replaceAll('$FIXTURE_REPO', repo));
}, 120_000);
afterAll(async () => {
  for (const child of children) child.kill();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
});

describe('o8d MCP through the real HTTP JSON-RPC entry point', () => {
  it('replays the recorded tools/list request against both servers', async () => {
    const body = readFileSync('tests/fixtures/mcp-parity/list.json', 'utf8');
    const results = await Promise.all([base, rust].map((url) => sendRecordedMcp(url, token, { name: 'catalog', body })));
    expect(results[0].status).toBe(200);
    expect(results[1].status).toBe(200);
    compareMcpExchanges(results[0], results[1]);
  });

  it('replays every recorded request field by field against the same persisted state', async () => {
    expect(await replayMcp(base, rust, token, records)).toBe(records.length);
  }, 120_000);

  it.each(['o8_status', 'get_mission_status', 'o8_task_list', 'o8_list_repos', 'o8_list_projects', 'o8_lease_list'])(
    'serves %s without forwarding a tools/call to TypeScript', async (name) => {
      seen.length = 0;
      const result = await call(rust, name);
      expect(result.status).toBe(200);
      expect((result.body as { result: { isError: boolean } }).result.isError).toBe(false);
      const forwarded = seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method);
      expect(forwarded).toEqual(['o8d/read-context']);
    },
  );

  it('preserves sequential fresh-then-cached status semantics within a batch', async () => {
    await call(rust, 'o8_status', { fresh: true });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await sendRecordedMcp(rust, token, { name: 'sequential snapshots', body: [
      { jsonrpc: '2.0', id: 'fresh', method: 'tools/call', params: { name: 'o8_status', arguments: { fresh: true } } },
      { jsonrpc: '2.0', id: 'cached', method: 'tools/call', params: { name: 'o8_status', arguments: {} } },
    ] });
    const snapshots = (result.body as Array<{ result: { content: Array<{ text: string }> } }>).map((entry) =>
      JSON.parse(entry.result.content[0].text).data.snapshot.capturedAt);
    expect(snapshots[1]).toBe(snapshots[0]);
  });

  it.each([undefined, null])('does not refresh status for a notification id %s', async (id) => {
    seen.length = 0;
    const result = await sendRecordedMcp(rust, token, { name: 'status notification', body: {
      jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'o8_status', arguments: { fresh: true } },
    } });
    expect(result.status).toBe(202);
    expect(seen.map((entry) => entry.path)).toEqual(['/api/mcp']);
  });

  it('observes persisted updates after startup and returns compact/detailed tasks', async () => {
    const compact = toolPayload(await call(rust, 'o8_task_list', { includeDone: true }));
    expect(compact.tasks.length).toBeGreaterThanOrEqual(4);
    expect(compact.tasks.some((task: { group: string }) => task.group === 'done')).toBe(true);
    const lane = createLane({ repoPath: join(directory, 'repo'), runtime: 'codex', branch: 'fixture/after-start', label: 'After start' });
    const details = toolPayload(await call(rust, 'o8_task_list', { includeDone: true, includeDetails: true }));
    expect(details.tasks.find((task: { id: string }) => task.id === lane.id)).toMatchObject({ title: 'After start', summary: '', lane: { id: lane.id } });
    const persisted = getSqlite().prepare('SELECT id FROM lanes WHERE id = ?').get(lane.id);
    expect(persisted).toBeTruthy();
    compareMcpExchanges(await call(base, 'o8_task_list', { includeDone: true, includeDetails: true }),
      await call(rust, 'o8_task_list', { includeDone: true, includeDetails: true }));
  });

  it('forwards a mutation body and mixed batch exactly once with the original headers', async () => {
    const bodies = [
      ' { "jsonrpc": "2.0", "id": "mutation", "method": "tools/call", "params": { "name": "o8_create_project", "arguments": { "name": "Proxy fixture" } } } ',
      JSON.stringify([{ jsonrpc: '2.0', id: 0, method: 'tools/list' }, { jsonrpc: '2.0', id: 'mutate', method: 'tools/call', params: { name: 'o8_create_project', arguments: { name: 'Batch fixture' } } }]),
    ];
    for (const body of bodies) {
      seen.length = 0;
      const result = await sendRecordedMcp(rust, token, { name: 'mutation', body, headers: { 'x-fixture-correlation': 'original' } });
      expect(result.status).toBe(200);
      const forwarded = seen.filter((entry) => entry.path === '/api/mcp');
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0].body).toBe(body);
      expect(forwarded[0].headers['x-fixture-correlation']).toBe('original');
    }
    expect(getSqlite().prepare("SELECT name FROM projects WHERE name IN ('Proxy fixture', 'Batch fixture')").all()).toHaveLength(2);
  });

  it.each(['absent', 'invalid', 'read-only'] as const)('refuses %s callers before any read or mutation', async (credential) => {
    for (const body of [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'o8_create_project', arguments: { name: 'Refused' } } }]) {
      const recording = { name: credential, credential, body };
      const expected = await sendRecordedMcp(base, token, recording);
      seen.length = 0;
      const actual = await sendRecordedMcp(rust, token, recording);
      expect(actual.status).toBe(credential === 'read-only' ? 403 : 401);
      compareMcpExchanges(expected, actual);
      expect(seen.every((entry) => entry.path === '/api/mcp')).toBe(true);
    }
    expect(getSqlite().prepare("SELECT id FROM projects WHERE name = 'Refused'").all()).toHaveLength(0);
  });

  it.each(['worker', 'device', 'spectator', 'plugin'] as const)('refuses an active %s capability before source reads', async (kind) => {
    const credential = kind === 'plugin' ? mintPluginToken({ machineId: 'fixture', clientId: 'fixture', scopes: ['o8:read'] }) : refusedCredentials[kind];
    for (const body of [
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_status' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'o8_create_project', arguments: { name: 'Refused capability' } } },
    ]) {
      const recording = { name: kind, body };
      const expected = await sendRecordedMcp(base, credential, recording);
      seen.length = 0;
      const actual = await sendRecordedMcp(rust, credential, recording);
      expect(actual.status).toBe(403);
      compareMcpExchanges(expected, actual);
      expect(seen.map((entry) => entry.path)).toEqual(['/api/mcp']);
    }
    expect(getSqlite().prepare("SELECT id FROM projects WHERE name = 'Refused capability'").all()).toHaveLength(0);
  });

  it('cannot widen a server profile and defaults to TypeScript when the source opt-in is off', async () => {
    process.env.O8_OPERATOR_MCP_PROFILE = 'dogfood';
    try {
      const recording = { name: 'narrow', headers: { 'x-o8-mcp-profile': 'full' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'o8_status' } } };
      const expected = await sendRecordedMcp(base, token, recording);
      seen.length = 0;
      compareMcpExchanges(expected, await sendRecordedMcp(rust, token, recording));
      expect(seen.map((entry) => entry.path)).toEqual(['/api/mcp']);
      expect((await call(rust, 'o8_status')).body).toMatchObject({ result: { isError: true } });
    } finally { delete process.env.O8_OPERATOR_MCP_PROFILE; }
    delete process.env.O8D_MCP_READS;
    try { compareMcpExchanges(await call(base, 'o8_list_repos'), await call(rust, 'o8_list_repos')); }
    finally { process.env.O8D_MCP_READS = '1'; }
  });

  it('rechecks a rotated operator credential before returning the catalog', async () => {
    const recording = { name: 'rotation', body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } };
    const replacement = 'fixture-replacement-operator-credential';
    writeFileSync(join(directory, 'ws-token'), replacement);
    try {
      expect((await sendRecordedMcp(rust, token, recording)).status).toBe(401);
      compareMcpExchanges(await sendRecordedMcp(base, replacement, recording), await sendRecordedMcp(rust, replacement, recording));
    } finally { writeFileSync(join(directory, 'ws-token'), token); }
  });

  it('falls back only for the failing read source', async () => {
    const expected = await call(base, 'o8_task_list');
    seen.length = 0;
    failedSource = '/api/tasks';
    try {
      compareMcpExchanges(expected, await call(rust, 'o8_task_list'));
      expect(seen.filter((entry) => entry.path === '/api/mcp').map((entry) => JSON.parse(entry.body).method)).toEqual(['o8d/read-context', 'tools/call']);
    } finally { failedSource = ''; }
  });

  it('does not follow upstream redirects or expose malformed upstream bodies', async () => {
    let destinationHits = 0;
    const destination = createServer((_request, response) => { destinationHits += 1; response.writeHead(200).end(); });
    const destinationUrl = await listen(destination);
    let redirect = true;
    const upstream = createServer((_request, response) => {
      if (redirect) response.writeHead(307, { location: destinationUrl }).end();
      else response.writeHead(200, { 'content-type': 'application/json' }).end('fixture malformed');
    });
    const upstreamUrl = await listen(upstream);
    const candidate = await startRust(upstreamUrl);
    try {
      const request = { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), redirect: 'manual' as const };
      const response = await fetch(`${candidate}/api/mcp`, request);
      expect(response.status).toBe(307);
      await response.text();
      expect(destinationHits).toBe(0);
      redirect = false;
      const invalid = await fetch(`${candidate}/api/mcp`, request);
      expect(invalid.status).toBe(503);
      expect(await invalid.json()).toEqual({ error: 'o8d MCP upstream unavailable' });
      await stop(upstream);
      const missing = await fetch(`${candidate}/api/mcp`, request);
      expect(missing.status).toBe(503);
      expect(await missing.json()).toEqual({ error: 'o8d MCP upstream unavailable' });
    } finally {
      if (upstream.listening) await stop(upstream);
      await stop(destination);
    }
  });

  it('requires runtime opt-in and rejects non-loopback upstreams', async () => {
    const binary = process.env.O8D_MCP_TEST_BINARY ?? 'crates/o8d/target/debug/o8d-mcp';
    for (const args of [[], ['--experimental-mcp', '--listen', '0.0.0.0:0', '--upstream', base], ['--experimental-mcp', '--listen', '127.0.0.1:0', '--upstream', 'http://remote.invalid:1234']]) {
      await expect(promisify(execFile)(binary, args)).rejects.toThrow('o8d MCP failed');
    }
  });

  it('runs the URL-based parity CLI against both real listeners', async () => {
    const result = await promisify(execFile)(process.execPath, ['--import=tsx', 'scripts/mcp-parity.ts', `--reference=${base}`, `--candidate=${rust}`, '--recording=tests/fixtures/mcp-parity/portable.json'], {
      env: { ...process.env, O8_MCP_PARITY_TOKEN: token },
    });
    expect(result.stdout).toContain('MCP parity passed');
  });
  it.runIf(Boolean(process.env.O8_MCP_BENCH_REPORT))('measures both servers with the existing speed MCP client', async () => {
    await promisify(execFile)(process.execPath, ['scripts/mcp-benchmark.mjs', `--reference=${base}`,
      `--candidate=${rust}`, `--output=${process.env.O8_MCP_BENCH_REPORT}`], {
      env: { ...process.env, O8_MCP_PARITY_TOKEN: token },
    });
    const report = JSON.parse(readFileSync(process.env.O8_MCP_BENCH_REPORT!, 'utf8'));
    expect(report.results).toHaveLength(14);
    expect(report.samples).toBe(100);
  }, 180_000);

});
