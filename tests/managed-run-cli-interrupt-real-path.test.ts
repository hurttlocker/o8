import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const tsxImport = import.meta.resolve('tsx');

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
  it('retains the log and numeric exit receipt after a normal command exit', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-run-cli-normal-'));
    roots.push(dataDir);
    const harnessPath = join(dataDir, 'run-harness.mts');
    const runCommandModule = new URL('../cli/src/commands/run.ts', import.meta.url).href;
    writeFileSync(harnessPath, `
import { runRun } from ${JSON.stringify(runCommandModule)};
const code = await runRun({ human: false, verbose: false }, []);
process.exit(code);
`);
    const result = spawnSync(process.execPath, [
      '--import', tsxImport,
      harnessPath,
      'run', '--', process.execPath, '-e', 'console.log("normal-receipt"); process.exit(7)',
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        O8_API_PORT: '1',
        O8_API_TOKEN: 'test-token',
        CORTEX_IDE_DATA_DIR: dataDir,
      },
      encoding: 'utf8',
    });
    expect(result.status).toBe(7);
    expect(result.stdout).toContain('normal-receipt');

    const receiptDir = join(dataDir, 'logs', 'run');
    const metadataFile = readdirSync(receiptDir).find((name) => name.endsWith('.json'));
    if (!metadataFile) throw new Error('managed run did not retain metadata');
    const metadata = JSON.parse(readFileSync(join(receiptDir, metadataFile), 'utf8')) as { id: string };
    expect(readFileSync(join(receiptDir, `${metadata.id}.exit`), 'utf8')).toBe('7');
    expect(readFileSync(join(receiptDir, `${metadata.id}.log`), 'utf8')).toContain('normal-receipt');
  }, 15_000);

  it('forwards SIGINT, proves the process tree dead, and retains the post-mortem receipt', async () => {
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
      '--import', tsxImport,
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
    const receiptDir = join(dataDir, 'logs', 'run');
    expect(readFileSync(join(receiptDir, `${registered.id}.exit`), 'utf8')).toBe('signal:INT');
    expect(readFileSync(join(receiptDir, `${registered.id}.log`), 'utf8')).toContain('started-at');
    expect(JSON.parse(readFileSync(join(receiptDir, `${registered.id}.json`), 'utf8')))
      .toMatchObject({ id: registered.id, command: expect.any(String), mode: 'stream' });
    const tempBase = join(tmpdir(), `o8-run-${registered.id}`);
    for (const suffix of ['.go', '.env']) {
      expect(existsSync(`${tempBase}${suffix}`)).toBe(false);
    }
    sessions.pop();
    children.pop();
  }, 25_000);

  it('records SIGTERM from the wrapper and exposes it through run --last', async () => {
    let run: ManagedRunRecord | null = null;
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
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-run-cli-sigterm-'));
    roots.push(dataDir);
    const harnessPath = join(dataDir, 'run-harness.mts');
    const runCommandModule = new URL('../cli/src/commands/run.ts', import.meta.url).href;
    writeFileSync(harnessPath, `
import { runRun } from ${JSON.stringify(runCommandModule)};
const code = await runRun({ human: false, verbose: false }, []);
process.exit(code);
`);
    const command = 'process.stdout.write("before-term\\n"); setInterval(() => {}, 1000)';
    const cli = spawn(process.execPath, [
      '--import', tsxImport,
      harnessPath,
      'run', '--detach', '--', process.execPath, '-e', command,
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
    let cliExitState: { code: number | null } | null = null;
    cli.stdout?.on('data', (chunk) => { cliStdout += String(chunk); });
    cli.stderr?.on('data', (chunk) => { cliStderr += String(chunk); });
    cli.once('exit', (code) => { cliExitState = { code }; });
    children.push(cli);
    const registered = await waitFor(() => run).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout=${cliStdout}\nstderr=${cliStderr}`);
    });
    const cliExit = await waitFor(() => cliExitState);
    expect(cliExit.code).toBe(0);
    children.pop();

    const receiptDir = join(dataDir, 'logs', 'run');
    const logFile = join(receiptDir, `${registered.id}.log`);
    const exitFile = join(receiptDir, `${registered.id}.exit`);
    await waitFor(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('before-term')
      ? true
      : null);
    if (!registered.panePid) throw new Error('managed run did not register a pane pid');
    process.kill(registered.panePid, 'SIGTERM');

    const exitReceipt = await waitFor(() => existsSync(exitFile) ? readFileSync(exitFile, 'utf8') : null);
    expect(exitReceipt).toBe('signal:TERM');
    await waitFor(() => markerPids(registered.processMarker!).length === 0 ? true : null);
    await waitFor(() => {
      try {
        execFileSync('tmux', ['has-session', '-t', registered.session], { stdio: 'ignore' });
        return null;
      } catch {
        return true;
      }
    });

    const last = spawnSync(process.execPath, [
      '--import', tsxImport,
      harnessPath,
      'run', '--last',
    ], {
      cwd: process.cwd(),
      env: { ...process.env, CORTEX_IDE_DATA_DIR: dataDir },
      encoding: 'utf8',
    });
    expect(last.status).toBe(0);
    expect(JSON.parse(last.stdout)).toMatchObject({
      schema: 'o8/cli/run.last/v1',
      run: {
        id: registered.id,
        command: expect.stringContaining('before-term'),
        startedAt: expect.any(String),
        exitStatus: 'signal:TERM',
        logPath: logFile,
      },
    });
    sessions.pop();
  }, 25_000);

  it('does not release a packet command when the server rejects its registration', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'o8-run-cli-held-packet-'));
    roots.push(dataDir);
    const worktreePath = join(dataDir, '.cortex-worktrees', 'packet-pkt-cli-held');
    mkdirSync(worktreePath, { recursive: true });
    const canonicalWorktreePath = realpathSync(worktreePath);
    const commandMarker = join(dataDir, 'command-started');
    let registerCalls = 0;
    let commandStartedBeforeRejection = false;
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url?.startsWith('/api/lanes') && request.method === 'GET') {
        response.end(JSON.stringify({
          lanes: [{
            id: 'lane-cli-held',
            packetId: 'pkt-cli-held',
            worktreePath: canonicalWorktreePath,
          }],
        }));
        return;
      }
      if (request.url === '/api/panel/managed-runs' && request.method === 'POST') {
        registerCalls += 1;
        commandStartedBeforeRejection = existsSync(commandMarker);
        response.statusCode = 409;
        response.end(JSON.stringify({
          ok: false,
          error: 'packet_not_accepting_managed_runs',
          reason: 'packet_held',
        }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: 'not_found' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('fixture server did not bind');

    const harnessPath = join(dataDir, 'run-harness.mts');
    const runCommandModule = new URL('../cli/src/commands/run.ts', import.meta.url).href;
    writeFileSync(harnessPath, `
import { runRun } from ${JSON.stringify(runCommandModule)};
try {
  const code = await runRun({ human: false, verbose: false }, []);
  process.exit(code);
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error));
  process.exit(typeof error === 'object' && error && 'exit' in error ? Number(error.exit) : 1);
}
`);
    const beforeSessions = new Set(execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean));
    const cli = spawn(process.execPath, [
      '--import', tsxImport,
      harnessPath,
      'run', '--detach', '--', process.execPath, '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(commandMarker)}, 'started')`,
    ], {
      cwd: canonicalWorktreePath,
      env: {
        ...process.env,
        O8_API_PORT: String(address.port),
        O8_API_TOKEN: 'test-token',
        CORTEX_IDE_DATA_DIR: dataDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(cli);
    let stdout = '';
    let stderr = '';
    cli.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    cli.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const status = await new Promise<number | null>((resolve) => cli.once('exit', resolve));
    children.pop();
    const afterSessions = new Set(execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
    }).trim().split('\n').filter(Boolean));

    expect(status, stderr).toBe(5);
    expect(stderr).toContain('Packet-bound run was not started');
    expect(stdout).toBe('');
    expect(registerCalls).toBe(1);
    expect(commandStartedBeforeRejection).toBe(false);
    expect(existsSync(commandMarker)).toBe(false);
    expect([...afterSessions].filter((session) => !beforeSessions.has(session))).toEqual([]);
  }, 25_000);
});
