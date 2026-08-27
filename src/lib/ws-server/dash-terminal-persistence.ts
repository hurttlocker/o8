import { execFileSync } from 'node:child_process';
import { recordPersistentTerminalHealth } from '@/lib/terminal/persistence-health';
import { resolveTmuxBinary } from '@/lib/ws-server/pty-support';

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
      dependencies.execFileSync(tmuxBin, ['has-session', '-t', input.sessionName], {
        windowsHide: true,
        timeout: 3000,
        stdio: 'ignore',
      });
      recordHealthSafely(dependencies, 'ready', 'session_reused');
      return true;
    } catch { /* not present, create it below */ }

    dependencies.execFileSync(tmuxBin, [
      'new-session', '-d', '-s', input.sessionName,
      '-x', String(input.cols), '-y', String(input.rows),
      input.shell, '-l',
    ], { windowsHide: true, cwd: input.cwd, timeout: 8000, env: input.env });
    created = true;
    dependencies.execFileSync(tmuxBin, [
      'set-option', '-t', input.sessionName, 'history-limit', '50000',
    ], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    dependencies.execFileSync(tmuxBin, [
      'set-option', '-t', input.sessionName, 'status', 'off',
    ], { windowsHide: true, timeout: 3000, stdio: 'ignore' });
    recordHealthSafely(dependencies, 'ready', 'session_created');
    console.log(`[persistent-terminals] created backing session: ${input.sessionName}`);
    return true;
  } catch (error) {
    if (created) {
      try {
        dependencies.execFileSync(tmuxBin, ['kill-session', '-t', input.sessionName], {
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
