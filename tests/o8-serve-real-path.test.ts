import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const cliEntrypoint = join(root, 'cli', 'dist', 'o8.mjs');
const dataDir = mkdtempSync(join(tmpdir(), 'o8-serve-real-path-'));

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
  apiPort: number;
  wsPort: number;
  mode: 'development' | 'packaged';
  children: Array<{ role: string; pid: number }>;
}

function cliEnv(): NodeJS.ProcessEnv {
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

function runCli(args: string[], timeout = 75_000): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [cliEntrypoint, ...args], {
      cwd: root,
      env: cliEnv(),
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

describe.sequential('o8 serve real CLI path', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(root, 'cli', 'esbuild.config.mjs')], {
      cwd: root,
      env: cliEnv(),
    });
  });

  afterAll(async () => {
    await runCli(['serve', 'stop'], 15_000);
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('starts, authenticates, reports, refuses a second owner, and reaps every child', async () => {
    const started = await runCli(['serve']);
    expect(started.code, `${started.stderr}\n${readFileSync(join(dataDir, 'logs', 'serve.log'), 'utf8')}`).toBe(0);
    const startStatus = JSON.parse(started.stdout) as ServeStatus;
    expect(startStatus).toMatchObject({
      schema: 'o8/cli/serve-status/v1',
      running: true,
      healthy: true,
      mode: 'development',
    });
    expect(startStatus.pid).toBeGreaterThan(0);
    expect(startStatus.apiPort).toBeGreaterThan(0);
    expect(startStatus.wsPort).toBeGreaterThan(0);
    expect(existsSync(join(dataDir, 'serve.pid'))).toBe(true);

    const token = readFileSync(join(dataDir, 'ws-token'), 'utf8').trim();
    const gatedResponse = await fetch(`http://127.0.0.1:${startStatus.apiPort}/api/panel/repos`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    expect(gatedResponse.status, await gatedResponse.text()).toBe(200);

    const statusResult = await runCli(['serve', 'status']);
    expect(statusResult.code, statusResult.stderr).toBe(0);
    expect(JSON.parse(statusResult.stdout)).toMatchObject({
      running: true,
      healthy: true,
      pid: startStatus.pid,
      apiPort: startStatus.apiPort,
      wsPort: startStatus.wsPort,
      mode: 'development',
    });

    const secondStart = await runCli(['serve']);
    expect(secondStart.code).toBe(5);
    expect(JSON.parse(secondStart.stderr)).toMatchObject({
      error: { code: 'serve_already_running', ambiguous: false },
    });

    const ownedPids = [startStatus.pid, ...descendantPids(startStatus.pid)];
    expect(ownedPids.length).toBeGreaterThanOrEqual(3);
    const stopped = await runCli(['serve', 'stop'], 15_000);
    expect(stopped.code, stopped.stderr).toBe(0);
    expect(JSON.parse(stopped.stdout)).toMatchObject({ stopped: true, pid: startStatus.pid });
    expect(existsSync(join(dataDir, 'serve.pid'))).toBe(false);
    expect(ownedPids.filter(processAlive)).toEqual([]);
  }, 120_000);
});
