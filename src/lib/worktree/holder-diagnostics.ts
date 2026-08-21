import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Post-failure diagnostic only. Do not use all-descriptor scans as a prune gate. */
export async function listWorktreeHolderPids(worktreePath: string): Promise<number[]> {
  const target = worktreePath.trim();
  if (!target) return [];

  try {
    const { stdout } = await execFileAsync('lsof', ['-Fn', '+D', path.resolve(target)], {
      windowsHide: true,
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return [...new Set(stdout.split('\n')
      .filter((line) => line.startsWith('p'))
      .map((line) => Number.parseInt(line.slice(1), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0))]
      .sort((left, right) => left - right);
  } catch {
    return [];
  }
}

export function formatWorktreeHolderPids(holderPids: number[]): string {
  if (holderPids.length === 0) return '';
  return ` Holder PID${holderPids.length === 1 ? '' : 's'}: ${holderPids.join(', ')}.`;
}
