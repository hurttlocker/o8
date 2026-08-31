import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const cliEntrypoint = join(root, 'cli', 'dist', 'o8.mjs');
const dataDirs = new Set<string>();

function makeDataDir(): string {
  const dataDir = mkdtempSync(join(tmpdir(), 'o8-serve-real-path-'));
  dataDirs.add(dataDir);
  return dataDir;
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface ServeStatus {
  schema: 'o8/cli/serve-status/v1';
  running: boolean;
  healthy: boolean;
  pid: number;
  pgid: number;
  apiPort: number;
  wsPort: number;
  mode: 'development' | 'packaged';
  cliVersion: string;
  daemonVersion: string | null;
  versionMismatch: boolean;
  warning: string | null;
  children: Array<{ role: string; pid: number }>;
  note: string;
}

function cliEnv(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    O8_DATA_DIR: dataDir,
    CORTEX_IDE_DATA_DIR: dataDir,
    O8_SERVE_ROOT: root,
    O8_WORKER_TOKEN: '',
    O8_WORKER_PACKET_ID: '',
  };
  delete env.NODE_OPTIONS;
  return env;
}

function runCli(args: string[], dataDir: string, timeout = 75_000): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliEntrypoint, ...args], {
      cwd: root,
      env: cliEnv(dataDir),
      timeout,
    }, (error, stdout, stderr) => {
      resolveResult({
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout,
        stderr,
      });
    });
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function descendantPids(rootPid: number): number[] {
  if (process.platform === 'win32') return [];
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
  const children = new Map<number, number[]>();
  for (const row of rows.split('\n')) {
    const [pidRaw, parentRaw] = row.trim().split(/\s+/);
    const pid = Number.parseInt(pidRaw ?? '', 10);
    const parent = Number.parseInt(parentRaw ?? '', 10);
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
    children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const descendants: number[] = [];
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (!pid) continue;
    descendants.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return descendants;
}

async function waitForPidsToExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !processAlive(pid))) return true;
    await new Promise((resolveWait) => { setTimeout(resolveWait, 50); });
  }
  return pids.every((pid) => !processAlive(pid));
}

function readServeLog(dataDir: string): string {
  const logPath = join(dataDir, 'logs', 'serve.log');
  return existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
}

describe.sequential('o8 serve real CLI path', () => {
  beforeAll(() => {
    const buildDataDir = makeDataDir();
    execFileSync(process.execPath, [join(root, 'cli', 'esbuild.config.mjs')], {
      cwd: root,
      env: cliEnv(buildDataDir),
    });
  });

  afterAll(async () => {
    for (const dataDir of dataDirs) {
      await runCli(['serve', 'stop'], dataDir, 15_000);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('starts, authenticates, reports, refuses a second owner, and reaps every child', async () => {
    const dataDir = makeDataDir();
    const desktopInstanceId = 'desktop-instance-id';
    writeFileSync(join(dataDir, 'instance-id'), desktopInstanceId, { mode: 0o600 });
    const started = await runCli(['serve'], dataDir);
    expect(started.code, `${started.stderr}\n${readServeLog(dataDir)}`).toBe(0);
    const startStatus = JSON.parse(started.stdout) as ServeStatus;
    expect(startStatus).toMatchObject({
      schema: 'o8/cli/serve-status/v1',
      running: true,
      healthy: true,
      mode: 'development',
    });
    expect(startStatus.pid).toBeGreaterThan(0);
    expect(startStatus.pgid).toBe(startStatus.pid);
    expect(startStatus.apiPort).toBeGreaterThan(0);
    expect(startStatus.wsPort).toBeGreaterThan(0);
    expect(startStatus.note).toContain('both can coexist');
    expect(startStatus.note).toContain('auto-update does not update a running daemon');
    expect(startStatus.cliVersion).toBe(startStatus.daemonVersion);
    expect(startStatus.versionMismatch).toBe(false);
    expect(startStatus.warning).toBeNull();
    expect(existsSync(join(dataDir, 'serve.pid'))).toBe(true);
    expect(readFileSync(join(dataDir, 'instance-id'), 'utf8')).toBe(desktopInstanceId);
    expect(readFileSync(join(dataDir, 'serve-instance-id'), 'utf8').trim()).not.toBe(desktopInstanceId);

    const token = readFileSync(join(dataDir, 'ws-token'), 'utf8').trim();
    const gatedResponse = await fetch(`http://127.0.0.1:${startStatus.apiPort}/api/panel/repos`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    expect(gatedResponse.status, await gatedResponse.text()).toBe(200);

    const statusResult = await runCli(['serve', 'status'], dataDir);
    expect(statusResult.code, statusResult.stderr).toBe(0);
    expect(JSON.parse(statusResult.stdout)).toMatchObject({
      running: true,
      healthy: true,
      pid: startStatus.pid,
      apiPort: startStatus.apiPort,
      wsPort: startStatus.wsPort,
      mode: 'development',
      pgid: startStatus.pid,
      cliVersion: startStatus.cliVersion,
      daemonVersion: startStatus.daemonVersion,
      versionMismatch: false,
      warning: null,
      note: startStatus.note,
    });

    const statePath = join(dataDir, 'serve-state.json');
    const persistedState = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    expect(persistedState.version).toBe(startStatus.cliVersion);
    writeFileSync(statePath, `${JSON.stringify({ ...persistedState, version: '0.0.0-stale' }, null, 2)}\n`, { mode: 0o600 });
    const mismatchedStatus = await runCli(['serve', 'status'], dataDir);
    expect(mismatchedStatus.code, mismatchedStatus.stderr).toBe(0);
    expect(JSON.parse(mismatchedStatus.stdout)).toMatchObject({
      cliVersion: startStatus.cliVersion,
      daemonVersion: '0.0.0-stale',
      versionMismatch: true,
      warning: expect.stringContaining('o8 serve restart'),
    });

    const initialOwnedPids = [startStatus.pid, ...descendantPids(startStatus.pid)];
    const restarted = await runCli(['serve', 'restart'], dataDir);
    expect(restarted.code, `${restarted.stderr}\n${readServeLog(dataDir)}`).toBe(0);
    const restartedStatus = JSON.parse(restarted.stdout) as ServeStatus;
    expect(restartedStatus).toMatchObject({
      running: true,
      healthy: true,
      mode: 'development',
      cliVersion: startStatus.cliVersion,
      daemonVersion: startStatus.cliVersion,
      versionMismatch: false,
      warning: null,
    });
    expect(restartedStatus.pid).not.toBe(startStatus.pid);
    expect(initialOwnedPids.filter(processAlive)).toEqual([]);

    const secondStart = await runCli(['serve'], dataDir);
    expect(secondStart.code).toBe(5);
    expect(JSON.parse(secondStart.stderr)).toMatchObject({
      error: { code: 'serve_already_running', ambiguous: false },
    });

    const ownedPids = [restartedStatus.pid, ...descendantPids(restartedStatus.pid)];
    expect(ownedPids.length).toBeGreaterThanOrEqual(3);
    const stopped = await runCli(['serve', 'stop'], dataDir, 15_000);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ stopped: true, pid: restartedStatus.pid });
    expect(existsSync(join(dataDir, 'serve.pid'))).toBe(false);
    expect(ownedPids.filter(processAlive)).toEqual([]);
  }, 120_000);

  it('reaps recorded children and stale ownership after the daemon leader is killed', async () => {
    const dataDir = makeDataDir();
    const started = await runCli(['serve'], dataDir);
    expect(started.code, `${started.stderr}\n${readServeLog(dataDir)}`).toBe(0);
    const status = JSON.parse(started.stdout) as ServeStatus;
    const ownedPids = [status.pid, ...descendantPids(status.pid)];
    const recordedChildPids = status.children.map((child) => child.pid);
    expect(recordedChildPids.length).toBe(2);

    process.kill(status.pid, 'SIGKILL');
    expect(await waitForPidsToExit([status.pid], 5_000)).toBe(true);

    const stopped = await runCli(['serve', 'stop'], dataDir, 15_000);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ stopped: true, pid: status.pid });
    expect(existsSync(join(dataDir, 'serve.pid'))).toBe(false);
    expect(existsSync(join(dataDir, 'serve-state.json'))).toBe(false);
    expect(recordedChildPids.filter(processAlive)).toEqual([]);
    expect(ownedPids.filter(processAlive)).toEqual([]);
  }, 120_000);

  it('refuses a data directory owned by a healthy desktop API', async () => {
    const dataDir = makeDataDir();
    const server = createHttpServer((request, response) => {
      if (request.url === '/api/setup/identity') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ product: 'o8' }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', resolveListen);
    });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Fake desktop API did not bind to a TCP port.');
      writeFileSync(join(dataDir, 'api-port'), String(address.port), { mode: 0o600 });

      const result = await runCli(['serve'], dataDir, 15_000);
      expect(result.code).toBe(5);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: {
          code: 'serve_desktop_owns_data_dir',
          hint: expect.stringContaining('different O8_DATA_DIR'),
          ambiguous: false,
        },
      });
      expect(existsSync(join(dataDir, 'serve.pid'))).toBe(false);
      expect(existsSync(join(dataDir, 'serve-state.json'))).toBe(false);
    } finally {
      await new Promise<void>((resolveClose) => { server.close(() => resolveClose()); });
    }
  }, 30_000);
});
