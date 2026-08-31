import { spawn, spawnSync } from 'node:child_process';
import {
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

export interface ServeLogRotationDecision {
  rotateCurrent: boolean;
  truncatePrevious: boolean;
}

export interface ServeLaunchAgentPlistOptions {
  cliEntry: string;
  dataDir: string;
  logPath: string;
  nodePath: string;
  workingDirectory: string;
}

interface ServeAgentCommandOptions extends ServeLaunchAgentPlistOptions {
  assertDataDirAvailable: () => Promise<void>;
}

interface SuperviseServeDaemonOptions {
  cliEntry: string;
  launchMode: 'development' | 'packaged';
  logPath: string;
  pidFile: string;
  workingDirectory: string;
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

  const paths = requireLaunchctl();
  if (typedAction === 'install') {
    await options.assertDataDirAvailable();
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
  prepareServeLog(options.logPath);
  const logFd = openSync(options.logPath, 'a', 0o600);
  const child = spawn(process.execPath, [options.cliEntry, 'serve', '__daemon'], {
    cwd: options.workingDirectory,
    detached: true,
    env: {
      ...process.env,
      O8_SERVE_ROOT: options.workingDirectory,
      O8_SERVE_LAUNCH_MODE: options.launchMode,
    },
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  if (!child.pid) {
    throw new CliError('serve_spawn_failed', 'Failed to spawn the headless daemon.', EXIT.CONNECTION_REFUSED);
  }
  try {
    writeFileSync(options.pidFile, String(child.pid), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    try { child.kill('SIGTERM'); } catch {}
    throw error;
  }

  let stopping = false;
  const stopChild = (): void => {
    stopping = true;
    try { child.kill('SIGTERM'); } catch {}
  };
  process.once('SIGTERM', stopChild);
  process.once('SIGINT', stopChild);
  return await new Promise<number>((resolve) => {
    child.once('exit', (code, signal) => {
      try {
        if (readFileSync(options.pidFile, 'utf8').trim() === String(child.pid)) {
          rmSync(options.pidFile, { force: true });
        }
      } catch {}
      if (stopping) resolve(EXIT.OK);
      else resolve(code ?? (signal ? EXIT.CONNECTION_REFUSED : EXIT.OK));
    });
  });
}
