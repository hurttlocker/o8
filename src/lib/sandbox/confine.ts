import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

/** Confinement could not be applied, so the command did not start. */
export class ConfinementUnavailable extends Error {
  constructor() { super('Command confinement is unavailable'); }
}

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
// Writes a shell needs that reach no file: the null device and the descriptors
// the command already holds.
const DEVICES = ['/dev/null', '/dev/tty', '/dev/stdout', '/dev/stderr'];

/** What a confined command may do besides writing in its root and private temp dir. */
export interface ConfinementRules {
  /** TCP and other network access. */
  network: boolean;
  /** Writes to `root/.git`. Linux always allows them; Landlock cannot deny a path beneath an allowed root. */
  gitWrites: boolean;
}

/** Lane rules (#3385): no network and no writes to `.git`. */
export const LANE_CONFINEMENT: ConfinementRules = { network: false, gitWrites: false };

/**
 * The built-in orchestrator in Full access (#3658): writes only in the
 * workspace, its `.git` included, and the private temp dir; network as usual.
 */
export const WORKSPACE_CONFINEMENT: ConfinementRules = { network: true, gitWrites: true };

function succeeds(file: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: 5_000 }, error => resolve(!error));
  });
}

/**
 * Arguments that confine one process that runs lane content (#3385, #3414): writes only inside `root`
 * and the private `tmp`. Lane rules, the default, also deny network and writes
 * to `root/.git`. Both paths must already be real paths. This is a guardrail for
 * approved commands, not a boundary against a hostile one.
 *
 * macOS: a `sandbox-exec` prefix. The profile denies reading file contents and
 * listings in the o8 data directory outside the worktree (lookups still resolve,
 * so paths through it work) and every write outside `root` and `tmp`. Under lane
 * rules it also denies every network operation (loopback and Unix sockets
 * included) and then denies writes to `root/.git` again; the last matching rule wins. Paths reach the
 * profile as parameters, never as profile text, and the profile is checked by
 * running `true` under it first.
 *
 * Linux: `--write` arguments for the native supervisor, which applies Landlock
 * (writes and TCP) before the command starts and refuses to start it when
 * Landlock cannot. `--allow-tcp` leaves TCP alone. Landlock cannot deny `.git`
 * beneath an allowed root.
 */
export async function confinementArgs(root: string, tmp: string, platform: NodeJS.Platform = process.platform,
  rules: ConfinementRules = LANE_CONFINEMENT): Promise<string[]> {
  if (platform === 'linux') {
    return [...(rules.network ? ['--allow-tcp'] : []), ...[root, tmp, '/dev/null'].flatMap(path => ['--write', path])];
  }
  if (platform !== 'darwin') throw new ConfinementUnavailable();
  const dataDir = await realpath(getDataDir()).catch(() => getDataDir());
  const params = { ROOT: root, TMP: tmp, GIT: join(root, '.git'), DATA: dataDir };
  const profile = ['(version 1)', '(allow default)', ...(rules.network ? [] : ['(deny network*)']),
    '(deny file-read-data (subpath (param "DATA")))',
    '(allow file-read-data (subpath (param "ROOT")) (subpath (param "TMP")))',
    '(deny file-write*)',
    `(allow file-write* (subpath (param "ROOT")) (subpath (param "TMP")) ${DEVICES.map(device => `(literal "${device}")`).join(' ')} (subpath "/dev/fd"))`,
    ...(rules.gitWrites ? [] : ['(deny file-write* (subpath (param "GIT")))'])].join('');
  const prefix = [SANDBOX_EXEC, ...Object.entries(params).flatMap(([key, value]) => ['-D', `${key}=${value}`]), '-p', profile];
  if (!await succeeds(prefix[0], [...prefix.slice(1), '/usr/bin/true'])) throw new ConfinementUnavailable();
  return prefix;
}
