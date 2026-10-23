import { execFile } from '@/lib/providers/child-process';
import { promisify } from 'node:util';
import { observeCloseProcess } from './close-process-observation';

const run = promisify(execFile);
export interface CloseProcessRow { pid: number; group: number; parent: number; command: string }

export function parseCloseProcessTable(raw: string): CloseProcessRow[] {
  if (!raw.trim()) throw new Error('ps returned no process identity snapshot');
  return raw.trim().split('\n').map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) throw new Error('ps returned malformed process identity output');
    const [pid, group, parent] = match.slice(1, 4).map(Number);
    if (![pid, group, parent].every(Number.isSafeInteger) || pid! <= 0 || group! < 0 || parent! < 0) {
      throw new Error('ps returned malformed numeric process identity');
    }
    return Object.freeze({ pid: pid!, group: group!, parent: parent!, command: match[4]! });
  });
}

export function readCloseProcessTable(): Promise<CloseProcessRow[]> {
  return observeCloseProcess('process-table', async () => {
    const { stdout, stderr } = await run('ps', ['axeww', '-o', 'pid=,pgid=,ppid=,command='], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    if (stderr.trim()) throw new Error('ps probe returned incomplete output');
    return parseCloseProcessTable(stdout);
  });
}

/** The retained-run primitives are projections of the same native table. */
export async function closeProcessCommand(command: string, args: string[]): Promise<{
  code: number; stdout: string; stderr: string;
} | null> {
  if (command !== 'ps' && command !== 'pgrep') return null;
  try {
    const rows = await readCloseProcessTable();
    if (command === 'ps' && args.join(' ') === '-o pgid=,command= -p ' + args[3]) {
      const row = rows.find(row => row.pid === Number(args[3]));
      return { code: row ? 0 : 1, stdout: row ? `${row.group} ${row.command}\n` : '', stderr: '' };
    }
    if (command === 'ps' && args.join(' ') === 'axeww -o pid=,command=') {
      return { code: 0, stdout: rows.map(row => `${row.pid} ${row.command}`).join('\n'), stderr: '' };
    }
    if (command === 'pgrep' && args.length === 2 && (args[0] === '-P' || args[0] === '-g')) {
      const matching = rows.filter(row => (args[0] === '-P' ? row.parent : row.group) === Number(args[1]));
      return { code: matching.length ? 0 : 1, stdout: matching.map(row => row.pid).join('\n'), stderr: '' };
    }
    return null;
  } catch { return { code: 127, stdout: '', stderr: 'Native process snapshot is unavailable or inconclusive.' }; }
}
