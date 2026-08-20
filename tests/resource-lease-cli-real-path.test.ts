import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const testHome = mkdtempSync(path.join(os.tmpdir(), 'o8-resource-lease-real-path-'));
const dataDir = path.join(testHome, '.o8');
const token = 'resource-lease-real-path-token';
const resource = `test-suite:${process.cwd()}:full-serial`;
const originalHome = process.env.HOME;
const originalO8DataDir = process.env.O8_DATA_DIR;
const originalCortexDataDir = process.env.CORTEX_IDE_DATA_DIR;
const originalWsToken = process.env.WS_TOKEN;
mkdirSync(dataDir, { recursive: true });
writeFileSync(path.join(dataDir, 'ws-token'), `${token}\n`, 'utf8');
process.env.HOME = testHome;
process.env.O8_DATA_DIR = dataDir;
process.env.CORTEX_IDE_DATA_DIR = dataDir;
process.env.WS_TOKEN = token;

const leaseRoute = await import('@/app/api/leases/route');
const { closeDb, getSqlite } = await import('@/lib/db');

const holderScript = String.raw`
import { spawn } from 'node:child_process';
import path from 'node:path';

const cliArgs = [
  path.join(process.cwd(), 'cli/dist/o8.mjs'),
  'lease',
  'acquire',
  process.env.O8_TEST_RESOURCE,
  '--ttl',
  '2h',
];
if (process.env.O8_TEST_WAIT === '1') cliArgs.push('--wait');
const args = [process.execPath, ...cliArgs];
const cli = process.platform === 'win32'
  ? spawn(process.execPath, cliArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  : spawn('/bin/sh', [
      '-c',
      '"$@" & child=$!; trap "kill $child 2>/dev/null; wait $child 2>/dev/null; exit 0" TERM INT; wait "$child"; code=$?; sleep 0.02; exit "$code"',
      'o8-lease-shell',
      ...args,
    ], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
    });
process.stdout.write('O8_LEASE_CLI_PID ' + cli.pid + '\n');
let stdout = '';
let stderr = '';
cli.stdout.on('data', (chunk) => { stdout += String(chunk); });
cli.stderr.on('data', (chunk) => { stderr += String(chunk); });
cli.once('error', (error) => {
  process.stderr.write('O8_LEASE_CLI_ERROR ' + error.message + '\n');
  process.exit(1);
});
cli.once('exit', (code, signal) => {
  if (code !== 0) {
    process.stderr.write('O8_LEASE_CLI_EXIT ' + code + ' ' + signal + ' ' + stderr + stdout + '\n');
    process.exit(code ?? 1);
    return;
  }
  process.stdout.write('O8_LEASE_ACQUIRED ' + stdout.trim() + '\n');
  setInterval(() => {}, 1_000);
});
const stop = () => {
  if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGTERM');
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
`;

class HolderProcess {
  stdout = '';
  stderr = '';

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => { this.stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { this.stderr += chunk.toString(); });
  }

  async waitFor(marker: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.stdout.includes(marker)) {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        throw new Error(`Lease holder exited before ${marker}: ${this.stdout}${this.stderr}`);
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out before ${marker}: ${this.stdout}${this.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async waitForExit(timeoutMs = 10_000): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await Promise.race([
      once(this.child, 'exit').then(() => undefined),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error(`Timed out waiting for holder exit: ${this.stdout}${this.stderr}`)),
        timeoutMs,
      )),
    ]);
  }

  terminate(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill(signal);
  }
}

let apiServer: Server | null = null;
let apiPort = 0;
const holders = new Set<HolderProcess>();

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function writeRouteResponse(response: ServerResponse, routeResponse: Response): Promise<void> {
  response.writeHead(routeResponse.status, {
    'Content-Type': routeResponse.headers.get('Content-Type') ?? 'application/json',
    'Cache-Control': routeResponse.headers.get('Cache-Control') ?? 'no-store',
  });
  response.end(await routeResponse.text());
}

function launchHolder(wait: boolean): HolderProcess {
  const child = spawn(process.execPath, [
    '--import=tsx',
    '--input-type=module',
    '--eval',
    holderScript,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: testHome,
      O8_DATA_DIR: dataDir,
      CORTEX_IDE_DATA_DIR: dataDir,
      O8_API_PORT: String(apiPort),
      O8_API_TOKEN: token,
      O8_WORKER_TOKEN: '',
      O8_TEST_RESOURCE: resource,
      O8_TEST_WAIT: wait ? '1' : '0',
      O8_WORKER_PACKET_ID: '',
      O8_OWNED_RUN_MARKER: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_SESSION_ID: '',
      CODEX_THREAD_ID: '',
      TERM_SESSION_ID: '',
      AI_AGENT: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const holder = new HolderProcess(child);
  holders.add(holder);
  child.once('exit', () => holders.delete(holder));
  return holder;
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
        O8_WORKER_TOKEN: '',
        O8_WORKER_PACKET_ID: '',
        CLAUDE_CODE_SESSION_ID: '',
        CODEX_SESSION_ID: 'lease-cli-lifecycle',
        CODEX_THREAD_ID: '',
        TERM_SESSION_ID: '',
        AI_AGENT: 'test-agent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (exitCode) => resolveRun({ exitCode, stdout, stderr }));
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(process.cwd(), 'cli/esbuild.config.mjs')], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  apiServer = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', `http://127.0.0.1:${apiPort}`);
      if (requestUrl.pathname !== '/api/leases') {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'missing fixture route' }));
        return;
      }
      const body = await readBody(request);
      const nextRequest = new NextRequest(requestUrl, {
        method: request.method,
        headers: request.headers as HeadersInit,
        body: body || undefined,
      });
      if (request.method === 'GET') {
        await writeRouteResponse(response, await leaseRoute.GET(nextRequest));
        return;
      }
      if (request.method === 'POST') {
        await writeRouteResponse(response, await leaseRoute.POST(nextRequest));
        return;
      }
      response.writeHead(405, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'method not allowed' }));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolveListen) => apiServer!.listen(0, '127.0.0.1', resolveListen));
  const address = apiServer.address();
  if (!address || typeof address === 'string') throw new Error('Lease fixture server did not bind.');
  apiPort = address.port;
}, 30_000);

afterAll(async () => {
  for (const holder of holders) holder.terminate();
  await Promise.all([...holders].map((holder) => holder.waitForExit().catch(() => undefined)));
  await new Promise<void>((resolveClose, reject) => {
    if (!apiServer) return resolveClose();
    apiServer.close((error) => error ? reject(error) : resolveClose());
  });
  closeDb();
  rmSync(testHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalO8DataDir === undefined) delete process.env.O8_DATA_DIR;
  else process.env.O8_DATA_DIR = originalO8DataDir;
  if (originalCortexDataDir === undefined) delete process.env.CORTEX_IDE_DATA_DIR;
  else process.env.CORTEX_IDE_DATA_DIR = originalCortexDataDir;
  if (originalWsToken === undefined) delete process.env.WS_TOKEN;
  else process.env.WS_TOKEN = originalWsToken;
});

describe('resource lease CLI real path', () => {
  it('queues a second process, reaps a killed holder, and promotes the FIFO head', async () => {
    const first = launchHolder(false);
    await first.waitFor('O8_LEASE_ACQUIRED');
    expect(first.child.pid).toBeTypeOf('number');
    expect(getSqlite().prepare(`
      SELECT owner_id, owner_pid FROM resource_leases WHERE resource = ?
    `).get(resource)).toEqual({
      owner_id: `process:${first.child.pid}`,
      owner_pid: first.child.pid,
    });

    const second = launchHolder(true);
    await second.waitFor('O8_LEASE_CLI_PID');
    expect(second.child.pid).toBeTypeOf('number');
    await waitFor(() => {
      if (second.child.exitCode !== null || second.child.signalCode !== null) {
        throw new Error(`Second lease caller exited before queuing: ${second.stdout}${second.stderr}`);
      }
      if (second.stdout.includes('O8_LEASE_ACQUIRED')) {
        throw new Error(`Second lease caller bypassed the queue: ${second.stdout}${second.stderr}`);
      }
      const row = getSqlite().prepare(`
        SELECT owner_pid FROM resource_lease_waiters WHERE resource = ?
      `).get(resource) as { owner_pid: number } | undefined;
      return row?.owner_pid === second.child.pid;
    }, 'second CLI caller to enter the durable FIFO queue');

    first.terminate('SIGKILL');
    await first.waitForExit();
    expect(first.child.signalCode).toBe('SIGKILL');

    await second.waitFor('O8_LEASE_ACQUIRED');
    const current = getSqlite().prepare(`
      SELECT owner_id, owner_pid FROM resource_leases WHERE resource = ?
    `).get(resource) as { owner_id: string; owner_pid: number } | undefined;
    expect(current?.owner_pid).toBe(second.child.pid);
    expect(current?.owner_id).toBe(`process:${second.child.pid}`);
    expect(getSqlite().prepare(`
      SELECT COUNT(*) AS count FROM resource_lease_waiters WHERE resource = ?
    `).get(resource)).toEqual({ count: 0 });
    expect(getSqlite().prepare(`
      SELECT verb FROM resource_lease_events WHERE resource = ? ORDER BY sequence
    `).all(resource)).toEqual([
      { verb: 'acquired' },
      { verb: 'wait_enqueued' },
      { verb: 'reaped' },
      { verb: 'acquired' },
    ]);

    second.terminate();
    await second.waitForExit();
    await leaseRoute.GET(new NextRequest(
      `http://127.0.0.1:${apiPort}/api/leases?resource=${encodeURIComponent(resource)}`,
      { headers: { authorization: `Bearer ${token}` } },
    ));
    expect(getSqlite().prepare(`
      SELECT verb FROM resource_lease_events WHERE resource = ? ORDER BY sequence DESC LIMIT 1
    `).get(resource)).toEqual({ verb: 'reaped' });
  }, 30_000);

  it('acquires, reads, lists, and explicitly releases through the compiled CLI', async () => {
    const lifecycleResource = 'free-form:cli-lifecycle';
    const acquired = await runCli(['lease', 'acquire', lifecycleResource, '--ttl', '30s']);
    expect(acquired.exitCode, acquired.stderr).toBe(0);
    expect(JSON.parse(acquired.stdout)).toMatchObject({
      schema: 'o8/cli/lease.acquire/v1',
      ok: true,
      result: { state: 'acquired', lease: { resource: lifecycleResource } },
    });

    const status = await runCli(['lease', 'status', lifecycleResource]);
    expect(status.exitCode, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({
      schema: 'o8/cli/lease.status/v1',
      lease: { resource: lifecycleResource, holder: { owner: { pid: process.pid } } },
    });

    const listed = await runCli(['lease', 'list']);
    expect(listed.exitCode, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      schema: 'o8/cli/lease.list/v1',
      count: 1,
      leases: [{ resource: lifecycleResource }],
    });

    const released = await runCli(['lease', 'release', lifecycleResource]);
    expect(released.exitCode, released.stderr).toBe(0);
    expect(JSON.parse(released.stdout)).toMatchObject({
      schema: 'o8/cli/lease.release/v1',
      ok: true,
      result: { released: true, nextHolder: null },
    });
    expect(getSqlite().prepare(`
      SELECT verb FROM resource_lease_events WHERE resource = ? ORDER BY sequence
    `).all(lifecycleResource)).toEqual([
      { verb: 'acquired' },
      { verb: 'released' },
    ]);
  }, 30_000);
});
