import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeSession } from '@/lib/runtimes/types';
import { dashTmuxArgs } from '@/lib/ws-server/dash-terminal-persistence';
import { resolveTmuxBinary } from '@/lib/ws-server/pty-support';

const execFileAsync = promisify(execFile);

type Command = (file: string, args: string[]) => Promise<string>;

async function runCommand(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    windowsHide: true,
    timeout: 2_000,
    maxBuffer: 128 * 1024,
  });
  return stdout;
}

function ttyName(value: string): string {
  return path.basename(value.trim());
}

/** Bind only a runtime-verified live pid to the exact o8 tmux pane TTY. */
export async function discoverDashboardCliBindings(
  sessions: RuntimeSession[],
  command: Command = runCommand,
): Promise<Map<string, string>> {
  const candidates = sessions.filter((session) => (
    (session.runtimeId === 'codex' || session.runtimeId === 'claude-code')
    && session.status === 'running'
    && Number.isSafeInteger(session.pid)
    && (session.pid ?? 0) > 0
    && session.ownership === 'discovered'
  ));
  if (candidates.length === 0) return new Map();

  try {
    const [paneOutput, processOutput] = await Promise.all([
      command(resolveTmuxBinary(), dashTmuxArgs('list-panes', '-a', '-F', '#{session_name}|#{pane_tty}')),
      command('ps', ['-o', 'pid=,tty=', '-p', candidates.map((session) => String(session.pid)).join(',')]),
    ]);
    const paneByTty = new Map<string, string>();
    const ambiguousTtys = new Set<string>();
    for (const line of paneOutput.split('\n')) {
      const [sessionName, tty] = line.trim().split('|');
      if (!sessionName?.startsWith('cortex-dash-') || !tty?.startsWith('/dev/')) continue;
      const key = ttyName(tty);
      if (paneByTty.has(key)) ambiguousTtys.add(key);
      else paneByTty.set(key, sessionName);
    }

    const ttyByPid = new Map<number, string>();
    for (const line of processOutput.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\S+)$/);
      if (!match || match[2] === '??' || match[2] === '?') continue;
      ttyByPid.set(Number(match[1]), ttyName(match[2]));
    }

    const result = new Map<string, string>();
    for (const session of candidates) {
      const tty = ttyByPid.get(session.pid!);
      if (!tty || ambiguousTtys.has(tty)) continue;
      const terminal = paneByTty.get(tty);
      if (terminal) result.set(session.sessionKey, terminal);
    }
    return result;
  } catch {
    // An unavailable tmux server or process probe must leave ordinary shells alone.
    return new Map();
  }
}
