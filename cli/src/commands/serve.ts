import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, Socket } from 'node:net';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CliError, EXIT } from '../api.js';
import { resolveCliDataDir } from '../config.js';
import { printHumanKv, printJson, type OutputMode } from '../output.js';
import {
  prepareServeLog,
  runServeAgentCommand,
  superviseServeDaemon,
} from './serve-lifecycle.js';

const PROD_API_PORT_BLOCK = [47100, 47101, 47102, 47103, 47104] as const;
const PROD_WS_PORT_BLOCK = [47105, 47106, 47107, 47108, 47109] as const;
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 8_000;
const POLL_MS = 100;
const DESKTOP_COEXISTENCE_NOTE = 'The desktop app uses the next available API and WebSocket port block entries, so both can coexist.';

type ServeMode = 'development' | 'packaged';
type ServeStatus = 'starting' | 'ready' | 'stopping' | 'failed';

interface ServeChildState {
  role: 'api' | 'ws';
  pid: number;
}

interface ServeState {
  schema: 'o8/serve-state/v1';
  pid: number;
  pgid: number;
  apiPort: number;
  wsPort: number;
  mode: ServeMode;
  root: string;
  startedAt: string;
  status: ServeStatus;
  children: ServeChildState[];
  error?: string;
}

interface ServePaths {
  dataDir: string;
  pidFile: string;
  stateFile: string;
  apiPortFile: string;
  wsPortFile: string;
  tokenFile: string;
  logFile: string;
}

interface LaunchPlan {
  mode: ServeMode;
  root: string;
  api: { command: string; args: string[] };
  ws: { command: string; args: string[] };
}

function servePaths(): ServePaths {
  const dataDir = resolveCliDataDir();
  return {
    dataDir,
    pidFile: join(dataDir, 'serve.pid'),
    stateFile: join(dataDir, 'serve-state.json'),
    apiPortFile: join(dataDir, 'api-port'),
    wsPortFile: join(dataDir, 'ws-port'),
    tokenFile: join(dataDir, 'ws-token'),
    logFile: join(dataDir, 'logs', 'serve.log'),
  };
}

function parsePid(raw: string): number | null {
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readOwnerPid(paths: ServePaths): number | null {
  try {
    return parsePid(readFileSync(paths.pidFile, 'utf8'));
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function uniquePids(pids: number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
  for (const pid of uniquePids(pids)) {
    if (!processAlive(pid)) continue;
    try { process.kill(pid, signal); } catch {}
  }
}

function signalProcessGroup(pgid: number | undefined, signal: NodeJS.Signals): void {
  if (process.platform === 'win32' || !pgid || pgid <= 0) return;
  try { process.kill(-pgid, signal); } catch {}
}

function processGroupAlive(pgid: number | undefined): boolean {
  if (process.platform === 'win32' || !pgid || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(paths: ServePaths): ServeState | null {
  try {
    const parsed = JSON.parse(readFileSync(paths.stateFile, 'utf8')) as ServeState;
    return parsed?.schema === 'o8/serve-state/v1' ? parsed : null;
  } catch {
    return null;
  }
}

function writeState(paths: ServePaths, state: ServeState): void {
  const temporary = `${paths.stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, paths.stateFile);
}

function cleanStaleOwner(paths: ServePaths): void {
  const pid = readOwnerPid(paths);
  if (pid && processAlive(pid)) return;
  rmSync(paths.pidFile, { force: true });
  rmSync(paths.stateFile, { force: true });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function waitForPidsToExit(pids: number[], timeoutMs: number): Promise<boolean> {
  const trackedPids = uniquePids(pids);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (trackedPids.every((pid) => !processAlive(pid))) return true;
    await wait(POLL_MS);
  }
  return trackedPids.every((pid) => !processAlive(pid));
}

async function terminateTrackedPids(
  pids: number[],
  pgid: number | undefined,
  termTimeoutMs: number,
): Promise<boolean> {
  const trackedPids = uniquePids(pids);
  signalPids(trackedPids, 'SIGTERM');
  const trackedExited = await waitForPidsToExit(trackedPids, termTimeoutMs);
  if (trackedExited && !processGroupAlive(pgid)) return true;
  signalProcessGroup(pgid, 'SIGKILL');
  signalPids(trackedPids, 'SIGKILL');
  return await waitForPidsToExit(trackedPids, 1_000) && !processGroupAlive(pgid);
}

async function portAcceptsConnections(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function apiIsReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/setup/identity`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return false;
    const body = await response.json() as { product?: unknown };
    return body.product === 'o8';
  } catch {
    return false;
  }
}

function readPort(path: string): number | null {
  try {
    const port = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
  } catch {
    return null;
  }
}

async function assertDataDirAvailableForServe(paths: ServePaths): Promise<void> {
  if (existsSync(paths.pidFile)) return;
  const apiPort = readPort(paths.apiPortFile);
  if (!apiPort || !await apiIsReady(apiPort)) return;
  throw new CliError(
    'serve_desktop_owns_data_dir',
    `The desktop app already owns this data directory through its healthy API on port ${apiPort}.`,
    EXIT.CONFLICT,
    'Quit the desktop app or use a different O8_DATA_DIR or CORTEX_IDE_DATA_DIR, then retry.',
  );
}

async function takeAvailablePort(candidates: readonly number[], skip?: number): Promise<number> {
  for (const candidate of candidates) {
    if (candidate === skip) continue;
    // A listener bound on IPv6 or 0.0.0.0 can coexist with a short-lived
    // 127.0.0.1 probe on macOS. Check the real connect path before trusting a
    // successful bind, matching the sidecar's collision guard.
    if (await portAcceptsConnections(candidate)) continue;
    const port = await new Promise<number | null>((resolve) => {
      const server = createServer();
      server.unref();
      server.once('error', () => resolve(null));
      server.listen(candidate, '127.0.0.1', () => {
        server.close(() => resolve(candidate));
      });
    });
    if (port) return port;
  }
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate an ephemeral port.')));
        return;
      }
      const port = address.port;
      if (port === skip) {
        server.close(() => {
          void takeAvailablePort([], skip).then(resolve, reject);
        });
        return;
      }
      server.close(() => resolve(port));
    });
  });
}

function findProjectRoot(start: string): string | null {
  let current = start;
  const filesystemRoot = parse(current).root;
  while (true) {
    if (
      existsSync(join(current, 'package.json'))
      && existsSync(join(current, 'src', 'ws-server.ts'))
      && existsSync(join(current, 'node_modules', 'next', 'dist', 'bin', 'next'))
      && existsSync(join(current, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
    ) {
      return current;
    }
    if (current === filesystemRoot) return null;
    current = dirname(current);
  }
}

function resolveLaunchPlan(): LaunchPlan {
  const cliEntry = fileURLToPath(import.meta.url);
  const bundledServerDir = dirname(dirname(cliEntry));
  const bundledApi = join(bundledServerDir, 'server.js');
  const bundledWs = join(bundledServerDir, 'ws-server.mjs');
  if (existsSync(bundledApi) && existsSync(bundledWs)) {
    return {
      mode: 'packaged',
      root: bundledServerDir,
      api: { command: process.execPath, args: [bundledApi] },
      ws: { command: process.execPath, args: [bundledWs] },
    };
  }

  const configuredRoot = process.env.O8_SERVE_ROOT?.trim();
  const projectRoot = (configuredRoot && findProjectRoot(configuredRoot))
    || findProjectRoot(process.cwd())
    || findProjectRoot(dirname(cliEntry));
  if (!projectRoot) {
    throw new CliError(
      'serve_entries_missing',
      'Could not find bundled server entries or a source checkout with installed dependencies.',
      EXIT.NOT_FOUND,
      'Run from an o8 source checkout after `npm install`, or reinstall the packaged app.',
    );
  }
  return {
    mode: 'development',
    root: projectRoot,
    api: {
      command: process.execPath,
      args: [join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next'), 'dev'],
    },
    ws: {
      command: process.execPath,
      args: [join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/ws-server.ts'],
    },
  };
}

function getOrCreateToken(paths: ServePaths): string {
  try {
    const existing = readFileSync(paths.tokenFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {}
  const token = randomBytes(32).toString('hex');
  try {
    writeFileSync(paths.tokenFile, token, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(paths.tokenFile, 'utf8').trim();
      if (existing.length >= 16) return existing;
    }
    writeFileSync(paths.tokenFile, token, { mode: 0o600 });
  }
  return token;
}

function readOrCreateId(path: string): string {
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const id = randomUUID();
  try {
    writeFileSync(path, id, { flag: 'wx', mode: 0o600 });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(path, 'utf8').trim();
      if (existing) return existing;
    }
    throw error;
  }
}

function appendNodeImport(existing: string | undefined, path: string): string {
  const flag = `--import=${path}`;
  return existing?.trim() ? `${existing.trim()} ${flag}` : flag;
}

function spawnService(
  role: ServeChildState['role'],
  entry: LaunchPlan['api'],
  plan: LaunchPlan,
  env: NodeJS.ProcessEnv,
  apiPort: number,
): ChildProcess {
  const args = role === 'api' && plan.mode === 'development'
    ? [...entry.args, '-p', String(apiPort)]
    : entry.args;
  return spawn(entry.command, args, {
    cwd: plan.root,
    env,
    stdio: 'inherit',
  });
}

async function waitForDaemonReady(paths: ServePaths, pid: number): Promise<ServeState> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readState(paths);
    if (state?.pid === pid && state.status === 'failed') {
      throw new CliError('serve_start_failed', state.error ?? 'The daemon failed to start.', EXIT.CONNECTION_REFUSED);
    }
    if (
      state?.pid === pid
      && state.status === 'ready'
      && await apiIsReady(state.apiPort)
      && await portAcceptsConnections(state.wsPort)
    ) {
      return state;
    }
    if (!processAlive(pid)) break;
    await wait(POLL_MS);
  }
  throw new CliError(
    'serve_start_failed',
    'The headless server did not become ready before the startup deadline.',
    EXIT.CONNECTION_REFUSED,
    `Inspect ${paths.logFile}.`,
  );
}

function outputState(mode: OutputMode, state: ServeState, running: boolean, healthy: boolean): void {
  const payload = {
    schema: 'o8/cli/serve-status/v1',
    running,
    healthy,
    pid: state.pid,
    pgid: state.pgid,
    apiPort: state.apiPort,
    wsPort: state.wsPort,
    mode: state.mode,
    status: state.status,
    children: state.children,
    startedAt: state.startedAt,
    note: DESKTOP_COEXISTENCE_NOTE,
  };
  if (!mode.human) {
    printJson(payload);
    return;
  }
  printHumanKv([
    ['running', String(running)],
    ['healthy', String(healthy)],
    ['pid', String(state.pid)],
    ['pgid', String(state.pgid)],
    ['api', String(state.apiPort)],
    ['ws', String(state.wsPort)],
    ['mode', state.mode],
    ['status', state.status],
    ['note', DESKTOP_COEXISTENCE_NOTE],
  ]);
}

function outputStopped(mode: OutputMode, pid: number): number {
  const payload = { schema: 'o8/cli/serve-stop/v1', stopped: true, pid };
  if (mode.human) printHumanKv([['stopped', 'true'], ['pid', String(pid)]]);
  else printJson(payload);
  return EXIT.OK;
}

async function startServe(mode: OutputMode): Promise<number> {
  const paths = servePaths();
  mkdirSync(dirname(paths.logFile), { recursive: true });
  cleanStaleOwner(paths);
  const existingPid = readOwnerPid(paths);
  if (existingPid && processAlive(existingPid)) {
    throw new CliError(
      'serve_already_running',
      `Headless o8 is already running with pid ${existingPid}.`,
      EXIT.CONFLICT,
      'Run `o8 serve status` or `o8 serve stop`.',
    );
  }
  await assertDataDirAvailableForServe(paths);

  const plan = resolveLaunchPlan();
  prepareServeLog(paths.logFile);
  const logFd = openSync(paths.logFile, 'a', 0o600);
  const cliEntry = process.argv[1];
  const child = spawn(process.execPath, [cliEntry, 'serve', '__daemon'], {
    cwd: plan.root,
    detached: true,
    env: {
      ...process.env,
      O8_SERVE_ROOT: plan.root,
      O8_SERVE_LAUNCH_MODE: plan.mode,
    },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  if (!child.pid) {
    throw new CliError('serve_spawn_failed', 'Failed to spawn the headless daemon.', EXIT.CONNECTION_REFUSED);
  }
  try {
    writeFileSync(paths.pidFile, String(child.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    try { child.kill('SIGTERM'); } catch {}
    const ownerPid = readOwnerPid(paths);
    if (ownerPid && processAlive(ownerPid)) {
      throw new CliError(
        'serve_already_running',
        `Headless o8 is already running with pid ${ownerPid}.`,
        EXIT.CONFLICT,
      );
    }
    throw error;
  }
  child.unref();
  const state = await waitForDaemonReady(paths, child.pid);
  outputState(mode, state, true, true);
  return EXIT.OK;
}

async function runLaunchAgent(): Promise<number> {
  const paths = servePaths();
  mkdirSync(paths.dataDir, { recursive: true });
  cleanStaleOwner(paths);
  await assertDataDirAvailableForServe(paths);
  const ownerPid = readOwnerPid(paths);
  if (ownerPid && processAlive(ownerPid)) {
    throw new CliError('serve_already_running', `Headless o8 is already running with pid ${ownerPid}.`, EXIT.CONFLICT);
  }
  const plan = resolveLaunchPlan();
  return superviseServeDaemon({
    cliEntry: process.argv[1],
    launchMode: plan.mode,
    logPath: paths.logFile,
    pidFile: paths.pidFile,
    workingDirectory: plan.root,
  });
}

async function statusServe(mode: OutputMode): Promise<number> {
  const paths = servePaths();
  const pid = readOwnerPid(paths);
  const state = readState(paths);
  if (!pid || !state || state.pid !== pid || !processAlive(pid)) {
    const hasRecoverableChildren = Boolean(state?.children.some((child) => processAlive(child.pid)));
    if (!hasRecoverableChildren) cleanStaleOwner(paths);
    const payload = {
      schema: 'o8/cli/serve-status/v1',
      running: false,
      healthy: false,
      note: DESKTOP_COEXISTENCE_NOTE,
    };
    if (mode.human) {
      printHumanKv([
        ['running', 'false'],
        ['healthy', 'false'],
        ['note', DESKTOP_COEXISTENCE_NOTE],
      ]);
    }
    else printJson(payload);
    return EXIT.OK;
  }
  const healthy = state.status === 'ready'
    && await apiIsReady(state.apiPort)
    && await portAcceptsConnections(state.wsPort);
  outputState(mode, state, true, healthy);
  return healthy ? EXIT.OK : EXIT.CONNECTION_REFUSED;
}

async function stopServe(mode: OutputMode): Promise<number> {
  const paths = servePaths();
  const pid = readOwnerPid(paths);
  const state = readState(paths);
  const stateMatchesOwner = state && (!pid || state.pid === pid) ? state : null;
  const leaderPid = pid ?? stateMatchesOwner?.pid ?? null;
  if (!leaderPid) {
    cleanStaleOwner(paths);
    throw new CliError('serve_not_running', 'Headless o8 is not running.', EXIT.NOT_FOUND);
  }
  const childPids = stateMatchesOwner?.children.map((child) => child.pid) ?? [];
  const trackedPids = uniquePids([leaderPid, ...childPids]);
  if (!processAlive(leaderPid)) {
    const stopped = await terminateTrackedPids(childPids, stateMatchesOwner?.pgid, 1_000);
    cleanStaleOwner(paths);
    if (stopped && trackedPids.every((trackedPid) => !processAlive(trackedPid)) && !existsSync(paths.pidFile)) {
      return outputStopped(mode, leaderPid);
    }
    throw new CliError(
      'serve_stop_failed',
      `Headless o8 pid ${leaderPid} died, but one or more recorded children could not be stopped.`,
      EXIT.CONFLICT,
      `Inspect ${paths.logFile}.`,
    );
  }
  try {
    process.kill(leaderPid, 'SIGTERM');
  } catch {}
  const startedAt = Date.now();
  const deadline = startedAt + STOP_TIMEOUT_MS;
  const escalationAt = startedAt + Math.floor(STOP_TIMEOUT_MS / 2);
  let childrenSignaled = false;
  while (Date.now() < deadline) {
    if (!childrenSignaled && Date.now() >= escalationAt) {
      signalPids(childPids, 'SIGTERM');
      childrenSignaled = true;
    }
    if (
      trackedPids.every((trackedPid) => !processAlive(trackedPid))
      && !processGroupAlive(stateMatchesOwner?.pgid)
      && !existsSync(paths.pidFile)
    ) {
      return outputStopped(mode, leaderPid);
    }
    await wait(POLL_MS);
  }
  signalProcessGroup(stateMatchesOwner?.pgid, 'SIGKILL');
  signalPids(trackedPids, 'SIGKILL');
  await waitForPidsToExit(trackedPids, 1_000);
  const allProcessesStopped = trackedPids.every((trackedPid) => !processAlive(trackedPid))
    && !processGroupAlive(stateMatchesOwner?.pgid);
  if (allProcessesStopped) cleanStaleOwner(paths);
  if (allProcessesStopped && !existsSync(paths.pidFile)) {
    return outputStopped(mode, leaderPid);
  }
  throw new CliError(
    'serve_stop_failed',
    `Headless o8 pid ${leaderPid} did not stop before the shutdown deadline.`,
    EXIT.CONFLICT,
    `Inspect ${paths.logFile}.`,
  );
}

async function runDaemon(): Promise<number> {
  const paths = servePaths();
  mkdirSync(paths.dataDir, { recursive: true });
  const ownerDeadline = Date.now() + 2_000;
  while (readOwnerPid(paths) !== process.pid && Date.now() < ownerDeadline) await wait(10);
  if (readOwnerPid(paths) !== process.pid) return EXIT.CONFLICT;

  const plan = resolveLaunchPlan();
  const requestedMode = process.env.O8_SERVE_LAUNCH_MODE;
  if (requestedMode && requestedMode !== plan.mode) {
    throw new Error(`Launch mode changed from ${requestedMode} to ${plan.mode}.`);
  }
  const apiPort = await takeAvailablePort(PROD_API_PORT_BLOCK);
  const wsPort = await takeAvailablePort(PROD_WS_PORT_BLOCK, apiPort);
  const instanceId = readOrCreateId(join(paths.dataDir, 'serve-instance-id'));
  const bootId = randomUUID();
  writeFileSync(join(paths.dataDir, 'boot-id'), bootId, { mode: 0o600 });
  writeFileSync(paths.apiPortFile, String(apiPort), { mode: 0o600 });
  writeFileSync(paths.wsPortFile, String(wsPort), { mode: 0o600 });
  const token = getOrCreateToken(paths);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    O8_DATA_DIR: paths.dataDir,
    CORTEX_IDE_DATA_DIR: paths.dataDir,
    O8_API_PORT: String(apiPort),
    O8_WS_PORT: String(wsPort),
    PORT: String(apiPort),
    WS_PORT: String(wsPort),
    NEXT_ORIGIN: `http://127.0.0.1:${apiPort}`,
    O8_BOOT_ID: bootId,
    O8_INSTANCE_ID: instanceId,
    O8_NODE_BIN: process.execPath,
    O8_SIDECAR_PID: String(process.pid),
    WS_TOKEN: token,
    NODE_ENV: plan.mode === 'packaged' ? 'production' : 'development',
  };
  if (plan.mode === 'packaged') {
    env.O8_PACKAGED_APP = '1';
    env.NODE_COMPILE_CACHE = join(paths.dataDir, 'compile-cache');
    if (existsSync(join(plan.root, 'operator-mcp-server.mjs'))) {
      env.O8_BUNDLED_MCP_DIR = plan.root;
      env.O8_BUNDLED_MCP_PATH = join(plan.root, 'operator-mcp-server.mjs');
    }
  } else {
    env.NODE_OPTIONS = appendNodeImport(env.NODE_OPTIONS, join(plan.root, 'scripts', 'register-server-only-stub.mjs'));
  }

  const state: ServeState = {
    schema: 'o8/serve-state/v1',
    pid: process.pid,
    pgid: process.pid,
    apiPort,
    wsPort,
    mode: plan.mode,
    root: plan.root,
    startedAt: new Date().toISOString(),
    status: 'starting',
    children: [],
  };
  writeState(paths, state);

  const apiChild = spawnService('api', plan.api, plan, env, apiPort);
  const wsChild = spawnService('ws', plan.ws, plan, env, apiPort);
  if (!apiChild.pid || !wsChild.pid) throw new Error('Failed to start one or more server children.');
  state.children = [
    { role: 'api', pid: apiChild.pid },
    { role: 'ws', pid: wsChild.pid },
  ];
  writeState(paths, state);

  let shuttingDown = false;
  const shutdown = async (exitCode: number, reason?: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    state.status = reason ? 'failed' : 'stopping';
    if (reason) state.error = reason;
    writeState(paths, state);
    for (const child of [apiChild, wsChild]) {
      if (child.pid && processAlive(child.pid)) {
        try { child.kill('SIGTERM'); } catch {}
      }
    }
    const deadline = Date.now() + 3_000;
    while (
      Date.now() < deadline
      && [apiChild, wsChild].some((child) => child.pid && processAlive(child.pid))
    ) {
      await wait(50);
    }
    for (const child of [apiChild, wsChild]) {
      if (child.pid && processAlive(child.pid)) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }
    await Promise.all([apiChild, wsChild].map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    })));
    if (readOwnerPid(paths) === process.pid) {
      rmSync(paths.pidFile, { force: true });
      rmSync(paths.stateFile, { force: true });
    }
    process.exit(exitCode);
  };

  const fatalShutdown = (kind: string, reason: unknown): void => {
    const detail = reason instanceof Error ? reason.message : String(reason);
    void shutdown(EXIT.CONNECTION_REFUSED, `${kind}: ${detail}`).catch(() => {
      process.exit(EXIT.CONNECTION_REFUSED);
    });
  };

  process.once('SIGTERM', () => { void shutdown(EXIT.OK); });
  process.once('SIGINT', () => { void shutdown(EXIT.OK); });
  process.once('uncaughtException', (error) => { fatalShutdown('uncaughtException', error); });
  process.once('unhandledRejection', (reason) => { fatalShutdown('unhandledRejection', reason); });
  for (const [role, child] of [['api', apiChild], ['ws', wsChild]] as const) {
    child.once('exit', (code, signal) => {
      if (!shuttingDown) {
        void shutdown(EXIT.CONNECTION_REFUSED, `${role} child exited code=${String(code)} signal=${String(signal)}`);
      }
    });
  }

  const readyDeadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < readyDeadline) {
    if (await apiIsReady(apiPort) && await portAcceptsConnections(wsPort)) {
      state.status = 'ready';
      writeState(paths, state);
      await new Promise<void>(() => {});
      return EXIT.OK;
    }
    await wait(POLL_MS);
  }
  await shutdown(EXIT.CONNECTION_REFUSED, 'Server children did not become ready before the startup deadline.');
  return EXIT.CONNECTION_REFUSED;
}

export async function runServe(
  mode: OutputMode,
  subcommand: string | undefined,
  rest: string[],
): Promise<number> {
  if (subcommand === 'agent') {
    const paths = servePaths();
    const plan = resolveLaunchPlan();
    return runServeAgentCommand(mode, rest[0], rest.slice(1), {
      cliEntry: process.argv[1],
      dataDir: paths.dataDir,
      logPath: paths.logFile,
      nodePath: process.execPath,
      workingDirectory: plan.root,
      assertDataDirAvailable: () => assertDataDirAvailableForServe(paths),
    });
  }
  if (rest.length > 0) {
    throw new CliError('invalid_serve_args', `Unexpected serve arguments: ${rest.join(' ')}`, EXIT.INVALID_ARGS);
  }
  if (!subcommand) return startServe(mode);
  if (subcommand === 'status') return statusServe(mode);
  if (subcommand === 'stop') return stopServe(mode);
  if (subcommand === '__launch_agent') return runLaunchAgent();
  if (subcommand === '__daemon') return runDaemon();
  throw new CliError(
    'unknown_serve_subcommand',
    `Unknown serve subcommand: ${subcommand}`,
    EXIT.INVALID_ARGS,
    'Use `o8 serve`, `o8 serve status`, `o8 serve stop`, or `o8 serve agent status`.',
  );
}
