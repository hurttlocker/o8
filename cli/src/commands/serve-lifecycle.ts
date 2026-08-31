import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { CliError, EXIT } from '../api.js';
import { printHumanKv, printJson, type OutputMode } from '../output.js';

export const SERVE_LAUNCH_AGENT_LABEL = 'ai.o8.serve';
export const SERVE_LOG_ROTATE_BYTES = 20 * 1024 * 1024;
export const SERVE_PREVIOUS_LOG_TRUNCATE_BYTES = 5 * 1024 * 1024;
export const SERVE_SUPERVISOR_MAX_FAST_FAILURES = 5;
export const SERVE_SUPERVISOR_BACKOFF_CAP_MS = 30_000;
const SERVE_SUPERVISOR_BACKOFF_BASE_MS = 1_000;
const SERVE_SUPERVISOR_READY_POLL_MS = 100;

export interface ServeLogRotationDecision {
  rotateCurrent: boolean;
  truncatePrevious: boolean;
}

export interface ServeSupervisorRetryDecision {
  delayMs: number;
  exhausted: boolean;
}

export interface ServeLaunchAgentPlistOptions {
  cliEntry: string;
  dataDir: string;
  logPath: string;
  nodePath: string;
  workingDirectory: string;
}

interface ServeAgentCommandOptions extends ServeLaunchAgentPlistOptions {
  assertInstallAvailable: () => Promise<void>;
}

interface SuperviseServeDaemonOptions {
  cliEntry: string;
  launchMode: 'development' | 'packaged';
  logPath: string;
  pidFile: string;
  stateFile: string;
  workingDirectory: string;
}

interface ServeStateDocument {
  schema: 'o8/serve-state/v1';
  supervisorPid?: number;
  [key: string]: unknown;
}

interface WaitForSupervisorRestartOptions<T> {
  supervisorPid: number;
  timeoutMs: number;
  pollMs: number;
  logPath: string;
  processAlive: (pid: number) => boolean;
  readReadyState: () => Promise<T | null>;
}

function escapePlistValue(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plistString(value: string): string {
  return `    <string>${escapePlistValue(value)}</string>`;
}

export function buildServeLaunchAgentPlist(options: ServeLaunchAgentPlistOptions): string {
  const args = [options.nodePath, options.cliEntry, 'serve', '__launch_agent']
    .map(plistString)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVE_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapePlistValue(options.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>O8_DATA_DIR</key>
    <string>${escapePlistValue(options.dataDir)}</string>
    <key>CORTEX_IDE_DATA_DIR</key>
    <string>${escapePlistValue(options.dataDir)}</string>
    <key>O8_NODE_BIN</key>
    <string>${escapePlistValue(options.nodePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${escapePlistValue(options.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapePlistValue(options.logPath)}</string>
</dict>
</plist>
`;
}

export function decideServeLogRotation(
  currentBytes: number | null,
  previousBytes: number | null,
): ServeLogRotationDecision {
  return {
    rotateCurrent: currentBytes !== null && currentBytes > SERVE_LOG_ROTATE_BYTES,
    truncatePrevious: previousBytes !== null && previousBytes > SERVE_PREVIOUS_LOG_TRUNCATE_BYTES,
  };
}

export function formatServeLogSessionBoundary(
  startedAt: string,
  version: string,
  pid: number,
): string {
  return `\n=== o8 serve session ${startedAt} version=${version} pid=${pid} ===\n`;
}

export function decideServeSupervisorRetry(failureCount: number): ServeSupervisorRetryDecision {
  const exhausted = failureCount >= SERVE_SUPERVISOR_MAX_FAST_FAILURES;
  return {
    delayMs: exhausted
      ? 0
      : Math.min(SERVE_SUPERVISOR_BACKOFF_BASE_MS * (2 ** Math.max(0, failureCount - 1)), SERVE_SUPERVISOR_BACKOFF_CAP_MS),
    exhausted,
  };
}

export function formatServeSupervisorFailure(timestamp: string, failureCount: number): string {
  return `=== o8 serve supervisor ${timestamp} exiting after ${failureCount} consecutive daemon failures before ready; launchd will retry ===\n`;
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export function prepareServeLog(logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const previousLog = `${logPath}.prev`;
  const decision = decideServeLogRotation(fileSize(logPath), fileSize(previousLog));
  if (decision.truncatePrevious) truncateSync(previousLog, 0);
  if (decision.rotateCurrent) {
    rmSync(previousLog, { force: true });
    renameSync(logPath, previousLog);
  }
}

function readServeStateDocument(stateFile: string): ServeStateDocument | null {
  try {
    const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as ServeStateDocument;
    return parsed?.schema === 'o8/serve-state/v1' ? parsed : null;
  } catch {
    return null;
  }
}

function writeServeStateDocument(stateFile: string, state: ServeStateDocument): void {
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, stateFile);
}

function persistSupervisorPid(stateFile: string, reset: boolean): void {
  const current = reset ? null : readServeStateDocument(stateFile);
  writeServeStateDocument(stateFile, {
    ...(current ?? { schema: 'o8/serve-state/v1' }),
    supervisorPid: process.pid,
  });
}

function clearSupervisorPid(stateFile: string): void {
  const current = readServeStateDocument(stateFile);
  if (!current || current.supervisorPid !== process.pid) return;
  const { supervisorPid: _supervisorPid, ...remaining } = current;
  if (Object.keys(remaining).length === 1) rmSync(stateFile, { force: true });
  else writeServeStateDocument(stateFile, remaining as ServeStateDocument);
}

export function readServeSupervisorPid(stateFile: string): number | null {
  const pid = readServeStateDocument(stateFile)?.supervisorPid;
  return Number.isInteger(pid) && Number(pid) > 0 ? Number(pid) : null;
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => { child.once('exit', () => resolve()); });
}

async function daemonReachedReadyBeforeExit(
  child: ChildProcess,
  stateFile: string,
  leafPid: number,
): Promise<boolean> {
  const exited = waitForChildExit(child);
  let reachedReady = false;
  while (child.exitCode === null && child.signalCode === null) {
    const state = readServeStateDocument(stateFile);
    if (state?.pid === leafPid && state.status === 'ready') {
      reachedReady = true;
      break;
    }
    await Promise.race([
      exited,
      new Promise((resolve) => { setTimeout(resolve, SERVE_SUPERVISOR_READY_POLL_MS); }),
    ]);
  }
  await exited;
  return reachedReady;
}

export async function waitForSupervisorRestart<T>(
  options: WaitForSupervisorRestartOptions<T>,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline && options.processAlive(options.supervisorPid)) {
    const state = await options.readReadyState();
    if (state) return state;
    await new Promise((resolve) => { setTimeout(resolve, options.pollMs); });
  }
  throw new CliError(
    'serve_start_failed',
    'The launch-agent supervisor did not replace the headless daemon before the startup deadline.',
    EXIT.CONNECTION_REFUSED,
    `Inspect ${options.logPath}.`,
  );
}

function requireLaunchctl(): { domain: string; plistPath: string; target: string } {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    throw new CliError(
      'serve_agent_unsupported',
      'The o8 serve launch agent is available only on macOS.',
      EXIT.INVALID_ARGS,
    );
  }
  const domain = `gui/${process.getuid()}`;
  return {
    domain,
    plistPath: join(homedir(), 'Library', 'LaunchAgents', `${SERVE_LAUNCH_AGENT_LABEL}.plist`),
    target: `${domain}/${SERVE_LAUNCH_AGENT_LABEL}`,
  };
}

function launchctl(args: string[], allowFailure = false): boolean {
  const result = spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
  if (result.status === 0) return true;
  if (allowFailure) return false;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
  throw new CliError('serve_agent_launchctl_failed', `launchctl ${args[0]} failed: ${detail}`, EXIT.CONFLICT);
}

function serveAgentStatus(): { installed: boolean; label: string; loaded: boolean; plistPath: string } {
  const paths = requireLaunchctl();
  return {
    installed: existsSync(paths.plistPath),
    label: SERVE_LAUNCH_AGENT_LABEL,
    loaded: launchctl(['print', paths.target], true),
    plistPath: paths.plistPath,
  };
}

function outputAgentStatus(
  mode: OutputMode,
  action: 'install' | 'uninstall' | 'status',
): number {
  const status = serveAgentStatus();
  const payload = { schema: 'o8/cli/serve-agent/v1', action, ...status };
  if (mode.human) {
    printHumanKv([
      ['action', action],
      ['label', status.label],
      ['installed', String(status.installed)],
      ['loaded', String(status.loaded)],
      ['plist', status.plistPath],
    ]);
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

export async function runServeAgentCommand(
  mode: OutputMode,
  action: string | undefined,
  rest: string[],
  options: ServeAgentCommandOptions,
): Promise<number> {
  if (!action || rest.length > 0 || !['install', 'uninstall', 'status'].includes(action)) {
    throw new CliError(
      'invalid_serve_agent_args',
      `Unknown serve agent action: ${action ?? '(none)'}`,
      EXIT.INVALID_ARGS,
      'Use `o8 serve agent install`, `o8 serve agent uninstall`, or `o8 serve agent status`.',
    );
  }
  const typedAction = action as 'install' | 'uninstall' | 'status';
  if (typedAction === 'status') return outputAgentStatus(mode, typedAction);

  if (typedAction === 'install') {
    await options.assertInstallAvailable();
  }
  const paths = requireLaunchctl();
  if (typedAction === 'install') {
    mkdirSync(dirname(paths.plistPath), { recursive: true });
    mkdirSync(dirname(options.logPath), { recursive: true });
    writeFileSync(paths.plistPath, buildServeLaunchAgentPlist(options), { mode: 0o600 });
    launchctl(['bootout', paths.target], true);
    launchctl(['bootstrap', paths.domain, paths.plistPath]);
  } else {
    launchctl(['bootout', paths.target], true);
    rmSync(paths.plistPath, { force: true });
  }
  return outputAgentStatus(mode, typedAction);
}

export async function superviseServeDaemon(options: SuperviseServeDaemonOptions): Promise<number> {
  let child: ReturnType<typeof spawn> | null = null;
  let stopping = false;
  let restartRequested = false;
  let consecutiveFastFailures = 0;
  let resolveDelay: (() => void) | null = null;
  const wakeDelay = (): void => { resolveDelay?.(); };
  const waitForDelay = async (delayMs: number): Promise<void> => {
    await new Promise<void>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        resolveDelay = null;
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      resolveDelay = finish;
    });
  };
  const stopSupervisor = (): void => {
    stopping = true;
    try { child?.kill('SIGTERM'); } catch {}
    wakeDelay();
  };
  const restartChild = (): void => {
    if (stopping) return;
    restartRequested = true;
    try { child?.kill('SIGTERM'); } catch {}
    wakeDelay();
  };
  process.once('SIGTERM', stopSupervisor);
  process.once('SIGINT', stopSupervisor);
  process.on('SIGHUP', restartChild);
  persistSupervisorPid(options.stateFile, true);

  try {
    while (!stopping) {
      restartRequested = false;
      persistSupervisorPid(options.stateFile, true);
      prepareServeLog(options.logPath);
      const logFd = openSync(options.logPath, 'a', 0o600);
      child = spawn(process.execPath, [options.cliEntry, 'serve', '__daemon'], {
        cwd: options.workingDirectory,
        detached: true,
        env: {
          ...process.env,
          O8_SERVE_ROOT: options.workingDirectory,
          O8_SERVE_LAUNCH_MODE: options.launchMode,
          O8_SERVE_SUPERVISOR_PID: String(process.pid),
        },
        stdio: ['ignore', logFd, logFd],
      });
      closeSync(logFd);
      if (!child.pid) {
        throw new CliError('serve_spawn_failed', 'Failed to spawn the headless daemon.', EXIT.CONNECTION_REFUSED);
      }
      if (stopping) {
        try { child.kill('SIGTERM'); } catch {}
        await waitForChildExit(child);
        child = null;
        break;
      }
      if (restartRequested) restartRequested = false;
      try {
        writeFileSync(options.pidFile, String(child.pid), { flag: 'wx', mode: 0o600 });
      } catch (error) {
        try { child.kill('SIGTERM'); } catch {}
        throw error;
      }

      const leafPid = child.pid;
      const reachedReady = await daemonReachedReadyBeforeExit(child, options.stateFile, leafPid);
      try {
        if (readFileSync(options.pidFile, 'utf8').trim() === String(leafPid)) {
          rmSync(options.pidFile, { force: true });
        }
      } catch {}
      child = null;
      if (reachedReady) consecutiveFastFailures = 0;
      if (stopping) break;
      if (restartRequested) continue;
      if (process.platform !== 'win32') {
        try { process.kill(-leafPid, 'SIGTERM'); } catch {}
        await waitForDelay(1_000);
        try { process.kill(-leafPid, 'SIGKILL'); } catch {}
      }
      if (stopping) break;
      if (restartRequested) continue;
      if (reachedReady) continue;

      consecutiveFastFailures += 1;
      const retry = decideServeSupervisorRetry(consecutiveFastFailures);
      if (retry.exhausted) {
        appendFileSync(
          options.logPath,
          formatServeSupervisorFailure(new Date().toISOString(), consecutiveFastFailures),
          { mode: 0o600 },
        );
        return EXIT.CONNECTION_REFUSED;
      }
      await waitForDelay(retry.delayMs);
    }
    return EXIT.OK;
  } finally {
    wakeDelay();
    process.removeListener('SIGTERM', stopSupervisor);
    process.removeListener('SIGINT', stopSupervisor);
    process.removeListener('SIGHUP', restartChild);
    clearSupervisorPid(options.stateFile);
  }
}
