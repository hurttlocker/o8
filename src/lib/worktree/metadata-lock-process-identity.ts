import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

export interface MetadataLockProcessIdentity {
  version: 1;
  platform: 'darwin' | 'linux' | 'win32';
  bootId: string;
  startId: string;
}

export type MetadataLockProcessProbe =
  | { state: 'live'; identity: MetadataLockProcessIdentity }
  | { state: 'absent' }
  | { state: 'unknown'; detail: string };

interface CommandReceipt {
  code: number;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[]): Promise<CommandReceipt> {
  return new Promise((resolve) => {
    execFile(command, args, {
      encoding: 'utf8',
      env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
      maxBuffer: 64 * 1024,
      timeout: 2_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      const rawCode = (error as NodeJS.ErrnoException & { code?: unknown } | null)?.code;
      const code = typeof rawCode === 'number' ? rawCode : error ? 127 : 0;
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
    });
  });
}

function processPresence(pid: number): 'live' | 'absent' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'live';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'absent';
    if (code === 'EPERM') return 'live';
    return 'unknown';
  }
}

function cleanIdentityPart(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > 160 || /[^\x20-\x7e]/.test(normalized)) return null;
  return normalized;
}

async function probeLinux(pid: number): Promise<MetadataLockProcessProbe> {
  let bootId: string;
  let stat: string;
  try {
    [bootId, stat] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && processPresence(pid) === 'absent') return { state: 'absent' };
    return { state: 'unknown', detail: `Linux process identity could not be read (${code ?? 'unknown error'}).` };
  }
  const commandEnd = stat.lastIndexOf(') ');
  const fields = commandEnd >= 0 ? stat.slice(commandEnd + 2).trim().split(/\s+/) : [];
  const normalizedBootId = cleanIdentityPart(bootId);
  const startId = fields[19];
  if (!normalizedBootId || !startId || !/^\d+$/.test(startId)) {
    return { state: 'unknown', detail: 'Linux process identity had an unsupported shape.' };
  }
  return {
    state: 'live',
    identity: { version: 1, platform: 'linux', bootId: normalizedBootId, startId },
  };
}

async function probeDarwin(pid: number): Promise<MetadataLockProcessProbe> {
  const [boot, started] = await Promise.all([
    runCommand('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']),
    runCommand('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]),
  ]);
  if (started.code !== 0 || !started.stdout.trim()) {
    if (processPresence(pid) === 'absent') return { state: 'absent' };
    return { state: 'unknown', detail: `macOS process start time could not be read (exit ${started.code}).` };
  }
  if (boot.code !== 0) {
    return { state: 'unknown', detail: `macOS boot-session identity could not be read (exit ${boot.code}).` };
  }
  const bootId = cleanIdentityPart(boot.stdout);
  const startId = cleanIdentityPart(started.stdout);
  if (!bootId || !startId) {
    return { state: 'unknown', detail: 'macOS process identity had an unsupported shape.' };
  }
  return {
    state: 'live',
    identity: { version: 1, platform: 'darwin', bootId, startId },
  };
}

async function probeWindows(pid: number): Promise<MetadataLockProcessProbe> {
  const script = [
    `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop`,
    'if ($null -eq $process) { exit 3 }',
    '$boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks',
    '$started = $process.CreationDate.ToUniversalTime().Ticks',
    '[Console]::Out.Write("$boot`n$started")',
  ].join('; ');
  const receipt = await runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]);
  if (receipt.code === 3 && processPresence(pid) === 'absent') return { state: 'absent' };
  if (receipt.code !== 0) {
    return { state: 'unknown', detail: `Windows process identity could not be read (exit ${receipt.code}).` };
  }
  const [rawBootId, rawStartId, ...extra] = receipt.stdout.trim().split(/\r?\n/);
  const bootId = cleanIdentityPart(rawBootId ?? '');
  const startId = cleanIdentityPart(rawStartId ?? '');
  if (!bootId || !startId || extra.length > 0 || !/^\d+$/.test(bootId) || !/^\d+$/.test(startId)) {
    return { state: 'unknown', detail: 'Windows process identity had an unsupported shape.' };
  }
  return {
    state: 'live',
    identity: { version: 1, platform: 'win32', bootId, startId },
  };
}

export function isMetadataLockProcessIdentity(value: unknown): value is MetadataLockProcessIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<MetadataLockProcessIdentity>;
  return Object.keys(value).sort().join(',') === 'bootId,platform,startId,version'
    && identity.version === 1
    && (identity.platform === 'darwin' || identity.platform === 'linux' || identity.platform === 'win32')
    && typeof identity.bootId === 'string'
    && cleanIdentityPart(identity.bootId) === identity.bootId
    && typeof identity.startId === 'string'
    && cleanIdentityPart(identity.startId) === identity.startId;
}

export function sameMetadataLockProcessIdentity(
  first: MetadataLockProcessIdentity,
  second: MetadataLockProcessIdentity,
): boolean {
  return first.version === second.version
    && first.platform === second.platform
    && first.bootId === second.bootId
    && first.startId === second.startId;
}

export async function probeMetadataLockProcessIdentity(
  pid: number,
): Promise<MetadataLockProcessProbe> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'unknown', detail: 'The metadata-lock PID is invalid.' };
  }
  const presence = processPresence(pid);
  if (presence === 'absent') return { state: 'absent' };
  if (presence === 'unknown') {
    return { state: 'unknown', detail: 'The metadata-lock PID could not be probed.' };
  }
  if (process.platform === 'linux') return probeLinux(pid);
  if (process.platform === 'darwin') return probeDarwin(pid);
  if (process.platform === 'win32') return probeWindows(pid);
  return { state: 'unknown', detail: `Process identity is unsupported on ${process.platform}.` };
}

function runCommandSync(command: string, args: string[]): CommandReceipt {
  const receipt = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    maxBuffer: 64 * 1024,
    timeout: 2_000,
    windowsHide: true,
  });
  return {
    code: typeof receipt.status === 'number' ? receipt.status : receipt.error ? 127 : 0,
    stdout: receipt.stdout ?? '',
    stderr: receipt.stderr ?? '',
  };
}

/** Synchronous form for SQLite boot recovery, where the schema hook cannot await. */
export function probeMetadataLockProcessIdentitySync(pid: number): MetadataLockProcessProbe {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { state: 'unknown', detail: 'The metadata-lock PID is invalid.' };
  }
  const presence = processPresence(pid);
  if (presence === 'absent') return { state: 'absent' };
  if (presence === 'unknown') return { state: 'unknown', detail: 'The metadata-lock PID could not be probed.' };
  if (process.platform === 'linux') {
    try {
      const bootId = cleanIdentityPart(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8'));
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const commandEnd = stat.lastIndexOf(') ');
      const fields = commandEnd >= 0 ? stat.slice(commandEnd + 2).trim().split(/\s+/) : [];
      const startId = fields[19];
      if (!bootId || !startId || !/^\d+$/.test(startId)) {
        return { state: 'unknown', detail: 'Linux process identity had an unsupported shape.' };
      }
      return { state: 'live', identity: { version: 1, platform: 'linux', bootId, startId } };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && processPresence(pid) === 'absent') return { state: 'absent' };
      return { state: 'unknown', detail: `Linux process identity could not be read (${code ?? 'unknown error'}).` };
    }
  }
  if (process.platform === 'darwin') {
    const boot = runCommandSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']);
    const started = runCommandSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)]);
    if (started.code !== 0 || !started.stdout.trim()) {
      return processPresence(pid) === 'absent'
        ? { state: 'absent' }
        : { state: 'unknown', detail: `macOS process start time could not be read (exit ${started.code}).` };
    }
    const bootId = boot.code === 0 ? cleanIdentityPart(boot.stdout) : null;
    const startId = cleanIdentityPart(started.stdout);
    return bootId && startId
      ? { state: 'live', identity: { version: 1, platform: 'darwin', bootId, startId } }
      : { state: 'unknown', detail: 'macOS process identity had an unsupported shape.' };
  }
  if (process.platform === 'win32') {
    const script = [
      `$process = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\" -ErrorAction Stop`,
      'if ($null -eq $process) { exit 3 }',
      '$boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().Ticks',
      '$started = $process.CreationDate.ToUniversalTime().Ticks',
      '[Console]::Out.Write("$boot`n$started")',
    ].join('; ');
    const receipt = runCommandSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (receipt.code === 3 && processPresence(pid) === 'absent') return { state: 'absent' };
    const [rawBootId, rawStartId, ...extra] = receipt.stdout.trim().split(/\r?\n/);
    const bootId = cleanIdentityPart(rawBootId ?? '');
    const startId = cleanIdentityPart(rawStartId ?? '');
    return receipt.code === 0 && bootId && startId && extra.length === 0
      ? { state: 'live', identity: { version: 1, platform: 'win32', bootId, startId } }
      : { state: 'unknown', detail: `Windows process identity could not be read (exit ${receipt.code}).` };
  }
  return { state: 'unknown', detail: `Process identity is unsupported on ${process.platform}.` };
}

/** Wall-clock boot instant for proving an identity-less legacy owner predates this boot. */
export function probeSystemBootTimeMsSync(): number | null {
  if (process.platform === 'linux') {
    try {
      const match = readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)$/m);
      return match ? Number(match[1]) * 1_000 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === 'darwin') {
    const receipt = runCommandSync('/usr/sbin/sysctl', ['-n', 'kern.boottime']);
    const match = receipt.code === 0 ? receipt.stdout.match(/sec\s*=\s*(\d+)/) : null;
    return match ? Number(match[1]) * 1_000 : null;
  }
  if (process.platform === 'win32') {
    const receipt = runCommandSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[Console]::Out.Write(([DateTimeOffset](Get-CimInstance Win32_OperatingSystem).LastBootUpTime).ToUnixTimeMilliseconds())',
    ]);
    const value = Number(receipt.stdout.trim());
    return receipt.code === 0 && Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  return null;
}
