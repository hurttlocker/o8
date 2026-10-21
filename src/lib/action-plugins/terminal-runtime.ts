import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createDashTmuxSessionSync, dashTmuxArgs } from '@/lib/ws-server/dash-terminal-persistence';
import { resolveTmuxBinary } from '@/lib/ws-server/pty-support';
import { ActionPluginError } from './errors';

export function pluginTerminalEnvironment(stateDirectory?: string): Record<string, string> & { NODE_ENV: 'production' } {
  return {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: homedir(),
    TERM: 'xterm-256color',
    NODE_ENV: 'production',
    ...(stateDirectory ? { O8_PLUGIN_STATE_DIR: stateDirectory } : {}),
  };
}

function tmux(...args: string[]) {
  return execFileSync(resolveTmuxBinary(), dashTmuxArgs(...args), {
    encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function requirePluginTerminalRuntime() {
  try { tmux('-V'); }
  catch { throw new ActionPluginError('terminal_unavailable', 'Persistent terminals need a working tmux installation. Install or repair tmux, then try again.', 503); }
}

export function inspectPluginTerminal(sessionName: string): { status: 'running' | 'exited' | 'ended'; exitCode: number | null } {
  if (!/^cortex-dash-[a-f0-9]{32}$/.test(sessionName)) throw new ActionPluginError('damaged', 'Invalid plugin terminal identity.', 409);
  try {
    const [dead, code] = tmux('display-message', '-p', '-t', sessionName, '#{pane_dead}:#{pane_dead_status}').trim().split(':');
    return { status: dead === '1' ? 'exited' : 'running', exitCode: dead === '1' && /^\d+$/.test(code ?? '') ? Number(code) : null };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    if (/can't find (session|pane)|no server running|error connecting.*No such file/u.test(stderr)) return { status: 'ended', exitCode: null };
    throw new ActionPluginError('terminal_unavailable', 'Could not inspect the persistent terminal host.', 503);
  }
}

export function startPluginTerminal(input: { sessionName: string; cwd: string; entry: string; args: string[]; stateDirectory?: string }) {
  const disabled = ['0', 'false', 'off', 'no'].includes(process.env.O8_PERSISTENT_TERMINALS?.trim().toLowerCase() ?? '');
  if (disabled) throw new ActionPluginError('persistence_disabled', 'Enable persistent terminals before launching a plugin terminal.', 409);
  const env = pluginTerminalEnvironment(input.stateDirectory);
  // env -i prevents a pre-existing tmux server from lending its credentials to
  // the plugin. The persistence adapter quotes each argument as literal data
  // before handing the command to tmux's command parser.
  const created = createDashTmuxSessionSync({
    enabled: true, sessionName: input.sessionName, cols: 120, rows: 30,
    cwd: input.cwd, shell: '/bin/sh', env,
    command: { file: '/usr/bin/env', args: ['-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), input.entry, ...input.args] },
    retainExited: true,
  });
  if (!created) throw new ActionPluginError('terminal_unavailable', 'Could not start a persistent terminal. Check that tmux is available.', 503);
  return inspectPluginTerminal(input.sessionName);
}

export function stopPluginTerminal(sessionName: string) {
  const current = inspectPluginTerminal(sessionName);
  if (current.status !== 'ended') tmux('kill-session', '-t', sessionName);
}
