import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface LiveClaudeProcess {
  pid: number;
  cwd?: string;
}

export interface LiveClaudeProbe {
  processes: LiveClaudeProcess[];
  probed: boolean;
}

export type ClaudeProcessProbeExec = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number },
) => Promise<{ stdout: string }>;

export async function probeLiveClaudeProcesses(options: {
  execFile?: ClaudeProcessProbeExec;
} = {}): Promise<LiveClaudeProbe> {
  const runExecFile = options.execFile ?? execFileAsync as ClaudeProcessProbeExec;
  try {
    const { stdout } = await runExecFile(
      'bash', ['-c', 'ps -eo pid=,command= | grep -E "claude (--|-)" | grep -v grep | grep -v ".app/"'],
      { windowsHide: true, timeout: 3000 },
    );
    const pids: number[] = [];
    for (const line of stdout.trim().split('\n').filter(Boolean)) {
      const match = line.trim().match(/^(\d+)/);
      if (match) pids.push(Number(match[1]));
    }
    if (pids.length === 0) return { processes: [], probed: true };

    const processes: LiveClaudeProcess[] = pids.map((pid) => ({ pid }));
    try {
      const { stdout: cwdOut } = await runExecFile(
        'lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn'],
        { windowsHide: true, timeout: 4000 },
      );
      let currentPid: number | null = null;
      for (const line of cwdOut.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = Number(line.slice(1));
        } else if (line.startsWith('n/') && currentPid !== null) {
          const proc = processes.find((candidate) => candidate.pid === currentPid);
          if (proc) proc.cwd = line.slice(1);
        }
      }
    } catch {
      return { processes, probed: false };
    }
    return { processes, probed: true };
  } catch (error) {
    const failure = error as { code?: unknown; killed?: unknown };
    return { processes: [], probed: failure.code === 1 && !failure.killed };
  }
}

export async function findLiveClaudeProcesses(): Promise<LiveClaudeProcess[]> {
  return (await probeLiveClaudeProcesses()).processes;
}
