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

export type OwnedRunProcessClaimProbe =
  | { state: 'match' }
  | { state: 'mismatch'; detail: string }
  | { state: 'unknown'; detail: string };

/** Prove that one claimed PID belongs to the run that minted a packet credential. */
export async function probeOwnedRunProcessClaim(input: {
  pid: number;
  marker: string;
  rootPid: number | null;
}): Promise<OwnedRunProcessClaimProbe> {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    return { state: 'mismatch', detail: 'The claimed worker PID is invalid.' };
  }
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(input.marker)) {
    return { state: 'unknown', detail: 'The authenticated worker process marker is unavailable.' };
  }
  if (process.platform === 'win32') {
    if (!input.rootPid || !Number.isSafeInteger(input.rootPid) || input.rootPid <= 0) {
      return { state: 'unknown', detail: 'The authenticated worker root PID is unavailable.' };
    }
    const script = [
      `$current = ${input.pid}`,
      `$root = ${input.rootPid}`,
      'for ($depth = 0; $depth -lt 32; $depth++) {',
      '  if ($current -eq $root) { [Console]::Out.Write("match"); exit 0 }',
      '  $row = Get-CimInstance Win32_Process -Filter "ProcessId = $current" -ErrorAction Stop',
      '  if ($null -eq $row -or $row.ParentProcessId -le 0) { break }',
      '  $current = [int]$row.ParentProcessId',
      '}',
      '[Console]::Out.Write("mismatch")',
    ].join('; ');
    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        script,
      ], {
        encoding: 'utf8',
        timeout: 3_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
      });
      return stdout.trim() === 'match'
        ? { state: 'match' }
        : { state: 'mismatch', detail: 'The claimed PID is outside the authenticated worker process tree.' };
    } catch (error) {
      return {
        state: 'unknown',
        detail: `The worker process tree could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  try {
    const { stdout } = await execFileAsync('ps', [
      'eww',
      '-p',
      String(input.pid),
      '-o',
      'command=',
    ], {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
    });
    const marker = `O8_OWNED_RUN_MARKER=${input.marker}`;
    return stdout.split(/\s+/).includes(marker)
      ? { state: 'match' }
      : { state: 'mismatch', detail: 'The claimed PID does not carry the authenticated worker process marker.' };
  } catch (error) {
    return {
      state: 'unknown',
      detail: `The claimed worker process environment could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
