import { EXIT } from '../api.js';
import { printHumanKv, printJson, type OutputMode } from '../output.js';
import { CLI_VERSION } from './version.js';

export const SERVE_STATUS_NOTE = 'The desktop app uses the next available API and WebSocket port block entries, so both can coexist. App auto-update does not update a running daemon; run `o8 serve restart` to pick up the new code.';

interface ServeOutputState {
  apiPort: number;
  children: Array<{ role: 'api' | 'ws'; pid: number }>;
  mode: 'development' | 'packaged';
  pgid: number;
  pid: number;
  startedAt: string;
  status: 'starting' | 'ready' | 'stopping' | 'failed';
  version?: string;
  wsPort: number;
}

export function outputServeState(
  mode: OutputMode,
  state: ServeOutputState,
  running: boolean,
  healthy: boolean,
): void {
  const daemonVersion = state.version ?? null;
  const versionMismatch = daemonVersion !== null && daemonVersion !== CLI_VERSION;
  const warning = versionMismatch
    ? `Invoking CLI version ${CLI_VERSION} differs from running daemon version ${daemonVersion}. Run \`o8 serve restart\` to pick up the new code.`
    : null;
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
    cliVersion: CLI_VERSION,
    daemonVersion,
    versionMismatch,
    warning,
    note: SERVE_STATUS_NOTE,
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
    ['cli version', CLI_VERSION],
    ['daemon version', daemonVersion ?? '(unknown)'],
    ['version mismatch', String(versionMismatch)],
    ...(warning ? [['warning', warning] as [string, string]] : []),
    ['note', SERVE_STATUS_NOTE],
  ]);
}

export function outputServeNotRunning(mode: OutputMode): number {
  const payload = {
    schema: 'o8/cli/serve-status/v1',
    running: false,
    healthy: false,
    cliVersion: CLI_VERSION,
    daemonVersion: null,
    versionMismatch: false,
    warning: null,
    note: SERVE_STATUS_NOTE,
  };
  if (mode.human) {
    printHumanKv([
      ['running', 'false'],
      ['healthy', 'false'],
      ['cli version', CLI_VERSION],
      ['daemon version', '(not running)'],
      ['note', SERVE_STATUS_NOTE],
    ]);
  } else {
    printJson(payload);
  }
  return EXIT.OK;
}

export function outputServeStopped(mode: OutputMode, pid: number): number {
  const payload = { schema: 'o8/cli/serve-stop/v1', stopped: true, pid };
  if (mode.human) printHumanKv([['stopped', 'true'], ['pid', String(pid)]]);
  else printJson(payload);
  return EXIT.OK;
}
