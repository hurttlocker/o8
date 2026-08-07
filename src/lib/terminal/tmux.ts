/**
 * tmux helper — server-side utility for managing tmux sessions.
 *
 * Used by runtime adapters to wrap agent processes in tmux for:
 * - Persistent sessions that survive disconnects
 * - Multi-client attach (dashboard + inspector can watch same agent)
 * - Interactive terminal input (users can type into agent's terminal)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Feature flag ──

/**
 * #6 persistent / crash-survivable terminals — default ON (live kill-test passed
 * on 0.1.513). Interactive dash terminals spawn INSIDE a tmux session (instead of
 * a plain ws-server-child PTY) so they outlive a ws-server restart / app crash and
 * re-attach with scrollback on relaunch. Explicit `0`/`false`/`off`/`no` opts out
 * (falls back to the plain-shell PTY). On machines without tmux the spawn helper
 * falls back automatically, so default-ON is safe there too.
 */
export function persistentTerminalsEnabled(): boolean {
  const raw = process.env.O8_PERSISTENT_TERMINALS?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

// ── Availability cache ──

let tmuxAvailableCache: boolean | null = null;

export async function isTmuxAvailable(): Promise<boolean> {
  if (tmuxAvailableCache !== null) return tmuxAvailableCache;
  try {
    await execFileAsync('tmux', ['-V'], { windowsHide: true, timeout: 3000 });
    tmuxAvailableCache = true;
  } catch {
    tmuxAvailableCache = false;
  }
  return tmuxAvailableCache;
}

// ── Session naming ──

/** Build a cortex tmux session name: cortex-{runtime}-{shortId} */
export function tmuxSessionName(runtime: string, id: string): string {
  // Use first 12 chars of id (enough to be unique, short enough for tmux)
  const shortId = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
  return `cortex-${runtime}-${shortId}`;
}

// ── Session lifecycle ──

export interface TmuxCreateResult {
  ok: boolean;
  sessionName: string;
  error?: string;
}

/**
 * Create a new tmux session running the given command.
 * Uses remain-on-exit so output is preserved after the process exits.
 */
export async function createTmuxSession(
  name: string,
  cmd: string,
  args: string[],
  cwd: string,
): Promise<TmuxCreateResult> {
  if (!(await isTmuxAvailable())) {
    return { ok: false, sessionName: name, error: 'tmux is not installed' };
  }

  // If session already exists, return success (idempotent)
  if (await tmuxSessionExists(name)) {
    return { ok: true, sessionName: name };
  }

  try {
    // Build the shell command to run inside tmux
    const shellCmd = [cmd, ...args].map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');

    await execFileAsync('tmux', [
      'new-session',
      '-d',              // detached
      '-s', name,        // session name
      '-x', '120',       // initial width
      '-y', '30',        // initial height
      'sh', '-c', shellCmd,
    ], {
      windowsHide: true,
      cwd,
      timeout: 10_000,
      env: { ...process.env },
    });

    // Set remain-on-exit so output persists after the process finishes
    await execFileAsync('tmux', [
      'set-option', '-t', name, 'remain-on-exit', 'on',
    ], { windowsHide: true, timeout: 3000 }).catch(() => { /* best effort */ });

    return { ok: true, sessionName: name };
  } catch (err) {
    return {
      ok: false,
      sessionName: name,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Check if a tmux session exists. */
export async function tmuxSessionExists(name: string): Promise<boolean> {
  try {
    await execFileAsync('tmux', ['has-session', '-t', name], { windowsHide: true, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/** Kill a tmux session. */
export async function killTmuxSession(name: string): Promise<void> {
  try {
    await execFileAsync('tmux', ['kill-session', '-t', name], { windowsHide: true, timeout: 5000 });
  } catch {
    // Already gone or doesn't exist — that's fine
  }
}

/** Rename an existing tmux session. */
export async function renameTmuxSession(currentName: string, nextName: string): Promise<void> {
  try {
    await execFileAsync('tmux', ['rename-session', '-t', currentName, nextName], { windowsHide: true, timeout: 5000 });
  } catch {
    // Best effort only
  }
}

/** List all cortex-prefixed tmux sessions. */
export async function listCortexTmuxSessions(): Promise<string[]> {
  if (!(await isTmuxAvailable())) return [];

  try {
    const { stdout } = await execFileAsync('tmux', [
      'list-sessions', '-F', '#{session_name}',
    ], { windowsHide: true, timeout: 3000 });

    return stdout
      .trim()
      .split('\n')
      .filter(name => name.startsWith('cortex-'));
  } catch {
    return [];
  }
}
