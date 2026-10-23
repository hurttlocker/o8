import { reserveWorkLaunch, type WorkLaunchLease } from '@/lib/app-update/work-launch-admission';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { recordPersistentTerminalHealth } from '@/lib/terminal/persistence-health';
import { DASH_PROFILE_OWNER_OPTION, dashProfileOwnerId } from '@/lib/terminal/dash-session-owner';
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
  /** Reviewed fixed executable; omitted for the normal login-shell path. */
  command?: { file: string; args: string[] };
  retainExited?: boolean;
}

interface CreateDashTmuxSessionDependencies {
  resolveTmuxBinary: typeof resolveTmuxBinary;
  execFileSync: typeof execFileSync;
  recordHealth: typeof recordPersistentTerminalHealth;
  resolveProfileOwnerId?: typeof dashProfileOwnerId;
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
  let launch: WorkLaunchLease | undefined;
  const sessionTarget = `=${input.sessionName}`;
  try {
    try {
      dependencies.execFileSync(tmuxBin, dashTmuxArgs('has-session', '-t', sessionTarget), {
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

    const profileOwner = (dependencies.resolveProfileOwnerId ?? dashProfileOwnerId)();
    launch = reserveWorkLaunch(`Terminal ${input.sessionName}`);
    launch.started(process.pid);
    const createdPane = dependencies.execFileSync(tmuxBin, dashTmuxArgs(
      'new-session', '-d', '-P', '-F', '#{pane_pid}', '-s', input.sessionName,
      '-x', String(input.cols), '-y', String(input.rows),
      // tmux parses standalone semicolons even in execFile argv. Keep reviewed
      // arguments inside one shell script, quoting every byte as literal data.
      ...(input.command ? ['/bin/sh', '-c', `exec ${[input.command.file, ...input.command.args].map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ')}`] : [input.shell, '-l']),
      ...(input.retainExited ? [';', 'set-option', '-t', `${sessionTarget}:`, 'remain-on-exit', 'on'] : []),
    ), { windowsHide: true, cwd: input.cwd, timeout: 8000, env: input.env, encoding: 'utf8' });
    created = true;
    // Capture the process in the creation receipt before any setup can fail.
    // A killed session then settles by PID liveness, even if setup threw.
    launch.started(Number.parseInt(String(createdPane), 10));
    // Claim only a session this process created. Reusing legacy/foreign sessions
    // never grants automatic-retirement authority over their existing owner.
    dependencies.execFileSync(tmuxBin, dashTmuxArgs(
      'set-option', '-t', `${sessionTarget}:`, DASH_PROFILE_OWNER_OPTION, profileOwner,
    ), { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    dependencies.execFileSync(tmuxBin, dashTmuxArgs(
      'set-option', '-t', `${sessionTarget}:`, 'history-limit', '50000',
    ), { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    dependencies.execFileSync(tmuxBin, dashTmuxArgs(
      'set-option', '-t', `${sessionTarget}:`, 'status', 'off',
    ), { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    // #1979 — disable only tmux `indn` (CSI n S), preserving alternate-screen
    // entry/exit while making full-screen scrolling use line feeds xterm keeps.
    ensureDashTerminalOverride(tmuxBin, dependencies);
    recordHealthSafely(dependencies, 'ready', 'session_created');
    const pane = dependencies.execFileSync(tmuxBin, dashTmuxArgs('display-message', '-p', '-t', `${sessionTarget}:`, '#{pane_pid}'),
      { windowsHide: true, timeout: 3000, encoding: 'utf8' });
    launch.started(Number.parseInt(String(pane), 10));
    console.log(`[persistent-terminals] created backing session: ${input.sessionName}`);
    return true;
  } catch (error) {
    if (!created && launch) {
      // A timed-out tmux client may already have created its detached shell.
      // Reconcile that process before deciding the start had no effect.
      try {
        const pane = dependencies.execFileSync(tmuxBin, dashTmuxArgs('display-message', '-p', '-t', `${sessionTarget}:`, '#{pane_pid}'),
          { windowsHide: true, timeout: 3000, encoding: 'utf8' });
        const pid = Number.parseInt(String(pane), 10);
        if (Number.isSafeInteger(pid) && pid > 0) { launch.started(pid); created = true; }
      } catch { /* A separate absence check below distinguishes failure from uncertainty. */ }
      if (!created) {
        try {
          dependencies.execFileSync(tmuxBin, dashTmuxArgs('has-session', '-t', sessionTarget), { windowsHide: true, timeout: 3000, stdio: 'ignore' });
          created = true;
        } catch (inspection) {
          if ((inspection as { status?: number }).status === 1) launch.release();
        }
      }
    }
    if (created) {
      try {
        dependencies.execFileSync(tmuxBin, dashTmuxArgs('kill-session', '-t', sessionTarget), {
          windowsHide: true,
          timeout: 3000,
          stdio: 'ignore',
        });
        // Keep ownership until a captured PID proves it exited; tmux success
        // alone cannot prove a shell that ignored SIGHUP has stopped.
      } catch { /* cleanup is best effort; the durable degraded receipt remains */ }
    }
    recordHealthSafely(dependencies, 'degraded', 'session_create_failed');
    console.warn(
      `[persistent-terminals] backing session creation failed; falling back to a plain shell: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
