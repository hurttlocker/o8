import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { terminateManagedRun } from '@/lib/runtimes/managed-runs/termination';
import type { ManagedRunRecord } from '@/lib/runtimes/managed-runs/types';

const servers: Server[] = [];
const children: ChildProcess[] = [];
const roots: string[] = [];
const sessions: string[] = [];
const tmuxAvailable = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

function markerPids(marker: string): number[] {
  try {
    const output = execFileSync('ps', ['eww', '-axo', 'pid=,command='], { encoding: 'utf8' });
    return output.split('\n').flatMap((line) => {
      if (!line.includes(`O8_MANAGED_RUN_MARKER=${marker}`)) return [];
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10);
      return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    });
  } catch {
    return [];
  }
}

async function waitFor<T>(read: () => T | null, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for streamed-run fixture');
}

afterEach(async () => {
  while (servers.length > 0) await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
  while (children.length > 0) {
    const child = children.pop()!;
    try { child.kill('SIGKILL'); } catch {}
  }
  while (sessions.length > 0) {
    try { execFileSync('tmux', ['kill-session', '-t', sessions.pop()!], { stdio: 'ignore' }); } catch {}
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.skipIf(!tmuxAvailable)('streamed o8 run Ctrl-C real entry point', () => {
  it('forwards SIGINT, proves the parent and grandchild dead, records exit 130, and cleans temp files', async () => {
    let run: ManagedRunRecord | null = null;
    let killCalls = 0;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/panel/managed-runs' && request.method === 'POST' && body.action === 'register') {
        run = {
          ...body,
          status: 'running',
          finishedAt: null,
          exitCode: null,
          termination: null,
        } as ManagedRunRecord;
        sessions.push(run.session);
        response.end(JSON.stringify({ ok: true, run }));
        return;
      }
      if (request.url === '/api/panel/managed-runs' && request.method === 'POST' && body.action === 'kill' && run) {
        killCalls += 1;
        const termination = await terminateManagedRun(run, {
          reason: 'stream_sigint',
          exitCode: 130,
        });
        if (termination.confirmedDead) {
          run.status = 'killed';
          run.exitCode = 130;
          run.finishedAt = termination.confirmedAt;
          run.termination = termination;
          response.end(JSON.stringify({ ok: true, run, termination }));
        } else {
          response.statusCode = 409;
          response.end(JSON.stringify({ ok: false, error: 'termination_unconfirmed', termination }));
        }
        return;
      }
      if (request.url === '/api/panel/managed-runs' && request.method === 'POST' && body.action === 'finish') {
        response.end(JSON.stringify({ ok: true, run }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-run-cli-interrupt-'));
    roots.push(dataDir);
    const harnessPath = join(dataDir, 'run-harness.mts');
    const runCommandModule = new URL('../cli/src/commands/run.ts', import.meta.url).href;
    writeFileSync(harnessPath, `
import { runRun } from ${JSON.stringify(runCommandModule)};
const code = await runRun({ human: false, verbose: false }, []);
process.exit(code);
`);
    const grandchild = [
      "process.on('SIGINT', () => {})",
      "process.on('SIGTERM', () => {})",
      'setInterval(() => {}, 1000)',
    ].join(';');
    const command = [
      "const { spawn } = require('node:child_process')",
      "process.on('SIGINT', () => {})",
      "process.on('SIGTERM', () => {})",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' })`,
      'setInterval(() => {}, 1000)',
    ].join(';');
    const cli = spawn(process.execPath, [
      '--import', 'tsx',
      harnessPath,
      'run', '--', process.execPath, '-e', command,
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        O8_API_PORT: String(address.port),
        O8_API_TOKEN: 'test-token',
        CORTEX_IDE_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let cliStdout = '';
    let cliStderr = '';
    cli.stdout?.on('data', (chunk) => { cliStdout += String(chunk); });
    cli.stderr?.on('data', (chunk) => { cliStderr += String(chunk); });
    children.push(cli);
    const registered = await waitFor(() => run).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout=${cliStdout}\nstderr=${cliStderr}`);
    });
    await waitFor(() => markerPids(registered.processMarker!).length >= 2 ? true : null);

    cli.kill('SIGINT');
    const exitCode = await new Promise<number | null>((resolve) => cli.once('exit', resolve));

    expect(exitCode).toBe(130);
    expect(killCalls).toBe(1);
    expect(registered).toMatchObject({ status: 'killed', exitCode: 130 });
    expect(registered.termination?.confirmedDead).toBe(true);
    expect(markerPids(registered.processMarker!)).toEqual([]);
    expect(() => execFileSync('tmux', ['has-session', '-t', registered.session], { stdio: 'ignore' }))
      .toThrow();
    const base = join(tmpdir(), `o8-run-${registered.id}`);
    for (const suffix of ['.log', '.exit', '.go', '.env']) {
      expect(existsSync(`${base}${suffix}`)).toBe(false);
    }
    sessions.pop();
    children.pop();
  }, 25_000);
});
