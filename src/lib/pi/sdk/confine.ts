import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Confinement could not be applied, so the command did not start. */
export class PiConfinementUnavailable extends Error {
  constructor() { super('Command confinement is unavailable'); }
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// Writes a shell needs that reach no file: the null device and the descriptors
// the command already holds.
const DEVICES = ['/dev/null', '/dev/tty', '/dev/stdout', '/dev/stderr'];

function succeeds(file: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 5_000 }, error => resolve(!error));
  });
}

/**
 * Arguments that confine one lane command (#3385): writes only inside `root`
 * (never its `.git`) and the private `tmp`, and no network. Both paths must
 * already be real paths. This is a guardrail for lane-approved commands, not
 * a boundary against a hostile one.
 *
 * macOS: a `sandbox-exec` prefix. The profile denies every network operation
 * (loopback and Unix sockets included), reading file contents and listings in
 * the o8 data directory outside the worktree (lookups still resolve, so paths
 * through it work), and every write outside `root` and `tmp`, then denies
 * writes to `root/.git` again; the last matching rule wins. Paths reach the
 * profile as parameters, never as profile text, and the profile is checked by
 * running `true` under it first.
 *
 * Linux: `--write` arguments for the native supervisor, which applies Landlock
 * (writes and TCP) before the command starts and refuses to start it when
 * Landlock cannot. Landlock cannot deny `.git` beneath an allowed root.
 */
export async function piConfinement(root: string, tmp: string, platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform === 'linux') return [root, tmp, '/dev/null'].flatMap(path => ['--write', path]);
  if (platform !== 'darwin') throw new PiConfinementUnavailable();
  const dataDir = await realpath(getDataDir()).catch(() => getDataDir());
  const params = { ROOT: root, TMP: tmp, GIT: join(root, '.git'), DATA: dataDir };
  const profile = ['(version 1)', '(allow default)', '(deny network*)',
    '(deny file-read-data (subpath (param "DATA")))',
    '(allow file-read-data (subpath (param "ROOT")) (subpath (param "TMP")))',
    '(deny file-write*)',
    `(allow file-write* (subpath (param "ROOT")) (subpath (param "TMP")) ${DEVICES.map(device => `(literal "${device}")`).join(' ')} (subpath "/dev/fd"))`,
    '(deny file-write* (subpath (param "GIT")))'].join('');
  const prefix = [SANDBOX_EXEC, ...Object.entries(params).flatMap(([key, value]) => ['-D', `${key}=${value}`]), '-p', profile];
  if (!await succeeds(prefix[0], [...prefix.slice(1), '/usr/bin/true'])) throw new PiConfinementUnavailable();
  return prefix;
}
