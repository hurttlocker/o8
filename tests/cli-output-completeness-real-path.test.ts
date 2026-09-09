/**
 * Real-path regression: the compiled `o8` binary must deliver COMPLETE output
 * through a pipe.
 *
 * `process.stdout` is asynchronous when it is a pipe — Node writes what the OS
 * pipe accepts (64 KiB on macOS) and buffers the remainder in userspace. The
 * CLI's top-level `process.exit()` used to run before that buffer drained, so a
 * large payload exited 0 while the consumer saw exactly one pipe buffer of
 * truncated JSON. The same payload redirected to a regular file (a synchronous
 * fd) was complete, which is why this never showed up in file-based checks.
 *
 * Everything here drives the REAL entry point: the bundled `cli/dist/o8.mjs`
 * spawned as a child process against an ephemeral loopback fixture, with a
 * disposable data dir. Completeness is judged only after the child's stdio
 * streams close ('close'), never on 'exit' — 'exit' can fire while stdout is
 * still being read. Payloads are synthetic.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

interface CliResult {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/** Multi-byte text that must survive chunked pipe writes intact. */
const MULTIBYTE = {
  cjk: '日本語テキスト・タスク',
  accented: 'café — naïve résumé',
  astral: '\u{1D11E}\u{1D122}',
};

const ONE_MIB = 1024 * 1024;

const dataDir = mkdtempSync(join(tmpdir(), 'o8-cli-output-completeness-'));
const cliEntry = join(process.cwd(), 'cli/dist/o8.mjs');
let apiServer: Server | null = null;
let apiPort = 0;

/** Deterministic synthetic task pool whose serialization exceeds 1 MiB. */
function buildLargeTaskPool(): Record<string, unknown> {
  const tasks = Array.from({ length: 2_400 }, (_, index) => ({
    id: `task-${index}`,
    packetId: null,
    laneId: null,
    title: `${MULTIBYTE.cjk} #${index}`,
    summary: `${MULTIBYTE.accented} ${MULTIBYTE.astral} ${'synthetic-filler-'.repeat(12)}${index}`,
    group: index % 2 === 0 ? 'done' : 'ready',
    status: 'synthetic',
    runtime: 'synthetic-runtime',
  }));
  return {
    schema: 'o8/cli/task-pool/v1',
    marker: `${MULTIBYTE.cjk}|${MULTIBYTE.accented}|${MULTIBYTE.astral}`,
    tasks,
  };
}

const largeTaskPool = buildLargeTaskPool();
const largeConflictNote = `${MULTIBYTE.cjk} ${'conflict-detail-'.repeat(80_000)}`;

const children = new Map<ChildProcess, Promise<void>>();

interface CliOptions {
  pause?: 'stdout' | 'stderr';
  resumeAfterMs?: number;
  closeStdoutEarly?: boolean;
  liveHandle?: boolean;
}

function runCli(args: string[], options: CliOptions = {}): Promise<CliResult> {
  return new Promise((resolveRun, reject) => {
    // Credentials here belong only to the ephemeral fixture, not to the
    // production control plane or the worker that is running this test.
    const env = { ...process.env };
    delete env.O8_WORKER_TOKEN;
    delete env.O8_WORKER_PACKET_ID;
    const preload = options.liveHandle ? ['--import', join(dataDir, 'live-handle.mjs')] : [];
    const child = spawn(process.execPath, [...preload, cliEntry, ...args], {
      cwd: process.cwd(),
      env: {
        ...env,
        CORTEX_IDE_DATA_DIR: dataDir,
        O8_DATA_DIR: dataDir,
        O8_API_PORT: String(apiPort),
        O8_API_TOKEN: 'synthetic-output-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
    children.set(child, new Promise<void>((resolve) => child.once('close', resolve)));
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.push(chunk);
      if (options.closeStdoutEarly) child.stdout.destroy();
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
    const paused = options.pause ? child[options.pause] : null;
    paused?.pause();
    const resumeTimer = paused && options.resumeAfterMs !== undefined
      ? setTimeout(() => paused.resume(), options.resumeAfterMs) : null;
    child.on('error', reject);
    child.on('exit', () => paused?.resume());
    // 'close' — not 'exit' — is the only point at which stdout is fully read.
    child.on('close', (exitCode, signal) => {
      clearTimeout(deadline);
      if (resumeTimer) clearTimeout(resumeTimer);
      children.delete(child);
      resolveRun({ exitCode, signal, timedOut, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

afterEach(async () => {
  const pending = [...children];
  for (const [child] of pending) child.kill('SIGKILL');
  await Promise.all(pending.map(([, closed]) => closed));
});

beforeAll(async () => {
  writeFileSync(join(dataDir, 'live-handle.mjs'), 'setInterval(() => {}, 1000);\n');
  execFileSync(process.execPath, [join(process.cwd(), 'cli/esbuild.config.mjs')], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });

  apiServer = createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer synthetic-output-token') {
      response.writeHead(401);
      response.end('{}');
      return;
    }
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (requestUrl.pathname !== '/api/tasks') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'missing fixture route' }));
      return;
    }
    const projectId = requestUrl.searchParams.get('projectId');
    if (projectId === 'missing') {
      response.writeHead(404, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'not_found' } }));
      return;
    }
    if (projectId === 'conflict') {
      response.writeHead(409, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ note: largeConflictNote }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(largeTaskPool));
  });
  await new Promise<void>((resolveListen) => apiServer!.listen(0, '127.0.0.1', resolveListen));
  const address = apiServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('CLI output-completeness fixture did not bind');
  }
  apiPort = address.port;
}, 60_000);

afterAll(async () => {
  apiServer?.closeAllConnections();
  await new Promise<void>((resolveClose, reject) => {
    if (!apiServer) return resolveClose();
    apiServer.close((error) => (error ? reject(error) : resolveClose()));
  });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('o8 CLI output completeness through a pipe', () => {
  it('delivers a >1 MiB JSON payload intact, with multi-byte text and one trailing newline', async () => {
    const result = await runCli(['task', 'list', '--include-done', '--project', 'large']);

    expect(result.exitCode, result.stderr.toString('utf8').slice(0, 2_000)).toBe(0);
    expect(result.stdout.byteLength).toBeGreaterThan(ONE_MIB);

    const text = result.stdout.toString('utf8');
    // Byte-exact: what printJson wrote is exactly what the consumer received.
    expect(text).toBe(`${JSON.stringify(largeTaskPool, null, 2)}\n`);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);

    const parsed = JSON.parse(text) as typeof largeTaskPool;
    expect(parsed).toEqual(largeTaskPool);
    expect((parsed as { marker: string }).marker)
      .toBe(`${MULTIBYTE.cjk}|${MULTIBYTE.accented}|${MULTIBYTE.astral}`);
    // No replacement character: no UTF-8 sequence was cut at a chunk boundary.
    expect(text).not.toContain('�');
  }, 60_000);

  it('delivers a >1 MiB structured error on stderr and preserves the conflict exit code', async () => {
    const result = await runCli(['task', 'list', '--project', 'conflict']);

    expect(result.exitCode).toBe(5);
    expect(result.stdout.byteLength).toBe(0);
    expect(result.stderr.byteLength).toBeGreaterThan(ONE_MIB);

    const body = JSON.parse(result.stderr.toString('utf8')) as {
      schema: string;
      error: { code: string; message: string };
    };
    expect(body.schema).toBe('o8/cli/error/v1');
    expect(body.error.code).toBe('conflict');
    expect(body.error.message.endsWith(largeConflictNote)).toBe(true);
  }, 60_000);

  it('preserves small structured errors and their exit codes', async () => {
    const result = await runCli(['task', 'list', '--project', 'missing']);

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stderr.toString('utf8'))).toMatchObject({
      schema: 'o8/cli/error/v1',
      error: { code: 'not_found' },
    });
  }, 60_000);

  // Draining before exit keeps the process alive long enough for a consumer
  // that walked away to raise EPIPE. `o8 <cmd> | head` must stay a clean,
  // prompt exit rather than a Node stack trace.
  it('exits cleanly and promptly when the consumer closes the pipe early', async () => {
    const startedAt = Date.now();
    const result = await runCli(['task', 'list', '--project', 'large'], { closeStdoutEarly: true });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.byteLength).toBeGreaterThan(0);
    expect(result.stdout.byteLength).toBeLessThan(ONE_MIB);
    expect(result.stderr.byteLength).toBe(0);
    // Bounded: an early-closing consumer must not hold the CLI for the
    // stalled-consumer timeout.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 60_000);

  it('does not report success when a reader stays blocked past the flush deadline', async () => {
    const result = await runCli(['task', 'list', '--project', 'large'], { pause: 'stdout' });
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stdout.byteLength).toBeLessThan(Buffer.byteLength(JSON.stringify(largeTaskPool, null, 2)));
    expect(JSON.parse(result.stderr.toString('utf8'))).toMatchObject({
      schema: 'o8/cli/error/v1', error: { code: 'output_incomplete', ambiguous: true },
    });
  }, 20_000);

  it('preserves a command failure code when its error output cannot drain', async () => {
    const result = await runCli(['task', 'list', '--project', 'conflict'], { pause: 'stderr' });
    expect(result.timedOut).toBe(false);
    expect(result.signal).toBeNull();
    expect(result.exitCode).toBe(5);
  }, 20_000);

  it('delivers the complete payload when a delayed reader resumes', async () => {
    const result = await runCli(['task', 'list', '--project', 'large'], { pause: 'stdout', resumeAfterMs: 500 });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.toString('utf8')).toBe(`${JSON.stringify(largeTaskPool, null, 2)}\n`);
  }, 20_000);

  it('exits after complete output even with an unrelated referenced timer', async () => {
    const startedAt = Date.now();
    const result = await runCli(['task', 'list', '--project', 'large'], { liveHandle: true });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stdout.toString('utf8')).toBe(`${JSON.stringify(largeTaskPool, null, 2)}\n`);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 20_000);
});
