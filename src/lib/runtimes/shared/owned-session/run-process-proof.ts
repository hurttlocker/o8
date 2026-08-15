import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function resolveSpawnedProcessGroupId(pid: number): Promise<number | undefined> {
  if (process.platform === 'win32' || pid <= 0) return undefined;
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    const pgid = Number.parseInt(stdout.trim(), 10);
    return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
  } catch {
    return undefined;
  }
}

export async function probeOwnedRunMarker(
  marker: string | undefined,
): Promise<'live' | 'clear' | 'unknown'> {
  if (!marker?.trim()) return 'unknown';
  try {
    const { stdout } = await execFileAsync('ps', ['eww', '-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    const needle = `O8_OWNED_RUN_MARKER=${marker}`;
    return stdout.split('\n').some((line) => line.includes(needle)) ? 'live' : 'clear';
  } catch {
    return 'unknown';
  }
}
