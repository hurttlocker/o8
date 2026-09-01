import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { recordPersistentTerminalHealth } from '@/lib/terminal/persistence-health';
import { resolveTmuxBinary } from '@/lib/ws-server/pty-support';

const DASH_TERMINAL_OWNER_KEY_MAX_LENGTH = 512;
export function dashTmuxServerName(): string {
  return process.env.O8_DASH_TMUX_SERVER_NAME?.trim() || 'o8-dashboard';
}
const DASH_TERMINAL_OVERRIDE = 'xterm*:indn@';

export function dashTmuxArgs(...args: string[]): string[] {
  return ['-L', dashTmuxServerName(), ...args];
}

function ensureDashTerminalOverride(
  tmuxBin: string,
  dependencies: CreateDashTmuxSessionDependencies,
) {
  const configured = String(dependencies.execFileSync(
    tmuxBin,
    dashTmuxArgs('show-options', '-gv', 'terminal-overrides'),
    { windowsHide: true, timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ));
  if (configured.split(/[\n,]/u).includes(DASH_TERMINAL_OVERRIDE)) return;
  dependencies.execFileSync(tmuxBin, dashTmuxArgs(
    'set-option', '-ga', 'terminal-overrides', `,${DASH_TERMINAL_OVERRIDE}`,
  ), { windowsHide: true, timeout: 3000, stdio: 'ignore' });
}

/**
 * Give a durable workspace tab the same tmux identity on every launch.
 *
 * The owner key never reaches the process list or tmux metadata. Hashing also
 * keeps the session name inside tmux's portable character/length envelope.
 */
export function dashSessionNameForOwnerKey(rawOwnerKey?: string | null): string | null {
  const ownerKey = rawOwnerKey?.trim() ?? '';
  if (!ownerKey || ownerKey.length > DASH_TERMINAL_OWNER_KEY_MAX_LENGTH) return null;
  const digest = createHash('sha256').update(ownerKey).digest('hex').slice(0, 32);
  return `cortex-dash-${digest}`;
}

interface CreateDashTmuxSessionInput {
  enabled: boolean;
  sessionName: string;
  cols: number;
  rows: number;
  cwd: string;
  shell: string;
  env: NodeJS.ProcessEnv;
}

interface CreateDashTmuxSessionDependencies {
  resolveTmuxBinary: typeof resolveTmuxBinary;
  execFileSync: typeof execFileSync;
  recordHealth: typeof recordPersistentTerminalHealth;
}

const DEFAULT_DEPENDENCIES: CreateDashTmuxSessionDependencies = {
  resolveTmuxBinary,
  execFileSync,
  recordHealth: recordPersistentTerminalHealth,
};

function recordHealthSafely(
  dependencies: CreateDashTmuxSessionDependencies,
  status: Parameters<typeof recordPersistentTerminalHealth>[0],
  reason: Parameters<typeof recordPersistentTerminalHealth>[1],
) {
  try {
    dependencies.recordHealth(status, reason);
  } catch (error) {
    console.warn(
      `[persistent-terminals] health receipt write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function createDashTmuxSessionSync(
  input: CreateDashTmuxSessionInput,
  dependencies: CreateDashTmuxSessionDependencies = DEFAULT_DEPENDENCIES,
): boolean {
  if (!input.enabled) {
    recordHealthSafely(dependencies, 'disabled', 'operator_disabled');
    return false;
  }

  let tmuxBin: string;
  try {
    tmuxBin = dependencies.resolveTmuxBinary();
  } catch (error) {
    recordHealthSafely(dependencies, 'degraded', 'tmux_unavailable');
    console.warn(
      `[persistent-terminals] backing runtime unavailable; falling back to a plain shell: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }

  let created = false;
  try {
    try {
      dependencies.execFileSync(tmuxBin, dashTmuxArgs('has-session', '-t', input.sessionName), {
        windowsHide: true,
        timeout: 3000,
        stdio: 'ignore',
      });
      // Reused sessions may predate #1979. The dedicated dashboard server keeps
      // this server option away from the operator's personal tmux, and the read
      // before append prevents duplicate entries across create/reuse cycles.
      ensureDashTerminalOverride(tmuxBin, dependencies);
      recordHealthSafely(dependencies, 'ready', 'session_reused');
      return true;
    } catch { /* not present, create it below */ }

    dependencies.execFileSync(tmuxBin, dashTmuxArgs(
      'new-session', '-d', '-s', input.sessionName,
      '-x', String(input.cols), '-y', String(input.rows),
      input.shell, '-l',
    ), { windowsHide: true, cwd: input.cwd, timeout: 8000, env: input.env });
    created = true;
    dependencies.execFileSync(tmuxBin, dashTmuxArgs(
      'set-option', '-t', input.sessionName, 'history-limit', '50000',
    ), { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    dependencies.execFileSync(tmuxBin, dashTmuxArgs(
      'set-option', '-t', input.sessionName, 'status', 'off',
    ), { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    // #1979 — disable only tmux `indn` (CSI n S), preserving alternate-screen
    // entry/exit while making full-screen scrolling use line feeds xterm keeps.
    ensureDashTerminalOverride(tmuxBin, dependencies);
    recordHealthSafely(dependencies, 'ready', 'session_created');
    console.log(`[persistent-terminals] created backing session: ${input.sessionName}`);
    return true;
  } catch (error) {
    if (created) {
      try {
        dependencies.execFileSync(tmuxBin, dashTmuxArgs('kill-session', '-t', input.sessionName), {
          windowsHide: true,
          timeout: 3000,
          stdio: 'ignore',
        });
      } catch { /* cleanup is best effort; the durable degraded receipt remains */ }
    }
    recordHealthSafely(dependencies, 'degraded', 'session_create_failed');
    console.warn(
      `[persistent-terminals] backing session creation failed; falling back to a plain shell: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
