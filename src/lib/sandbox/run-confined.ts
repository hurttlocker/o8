import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { piWriteHelperPath } from '@/lib/pi/sdk/scripts';
import { materializationAwareExecFile, materializationAwareInvocation } from '@/lib/worktree/materialization-execution';
import { confinementArgs, ConfinementUnavailable } from './confine';

export interface ConfinedRunOptions { cwd: string; timeout: number; maxBuffer: number }
export interface ConfinedRunResult { stdout: string; stderr: string; unconfined: boolean }

/** The supervisor, or null in a source checkout that has not built it. */
function supervisorPath(): string | null {
  try { return piWriteHelperPath(); } catch { return null; }
}

/**
 * The launch prefix for this host, or null when confinement is unavailable.
 * `supervised` is false only on macOS without the helper, where the
 * `sandbox-exec` prefix still confines but no supervisor ends descendants.
 */
async function confinedPrefix(root: string, tmp: string): Promise<{ prefix: string[]; supervised: boolean } | null> {
  try {
    const args = await confinementArgs(await realpath(root), tmp);
    const helper = supervisorPath();
    if (process.platform === 'linux') return helper ? { prefix: [helper, 'supervise', ...args, String(process.pid)], supervised: true } : null;
    return helper
      ? { prefix: [helper, 'supervise', String(process.pid), ...args], supervised: true }
      : { prefix: args, supervised: false };
  } catch {
    return null;
  }
}

function lastReceipt(text: string): { started: boolean; confirmed: boolean } | null {
  try {
    const receipt = JSON.parse(text.trim().split('\n').at(-1) ?? '') as { code?: unknown; signal?: unknown; confirmed?: unknown };
    return { started: receipt.code != null || receipt.signal != null, confirmed: receipt.confirmed === true };
  } catch { return null; }
}

/**
 * The pi-write supervisor tracks descendants and reports teardown on fd 3.
 * Linux uses Landlock; macOS launches the sandbox-exec prefix inside the supervisor.
 * SIGTERM asks it to tear the tree down.
 * Failures carry `code`, `signal`, `killed`, `stdout` and `stderr` like `execFile`.
 */
function runSupervised(command: string[], options: ConfinedRunOptions, env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string }> {
  const invocation = materializationAwareInvocation(command[0], command.slice(1), options.cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, { cwd: options.cwd, env, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let receipt = '';
    let killed = false;
    let hasExited = false;
    const stop = () => { if (!killed && !hasExited) { killed = true; child.kill('SIGTERM'); } };
    const take = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBuffer) { stop(); return; }
      into.push(chunk);
    };
    child.stdout?.on('data', take(stdout));
    child.stderr?.on('data', take(stderr));
    const receiptStream = child.stdio[3] as import('node:stream').Readable | null;
    receiptStream?.on('data', (chunk: Buffer) => {
      if (receipt.length < 4096) receipt += chunk.toString('utf8');
    });
    const timer = setTimeout(stop, options.timeout);
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.once('error', (error) => { hasExited = true; clearTimeout(timer); reject(error); });
    child.once('exit', async (code, signal) => {
      hasExited = true;
      clearTimeout(timer);
      // A lost supervisor can leave a descendant holding the pipes open.
      // Wait briefly for the receipt and buffered output, then fail closed.
      await Promise.race([closed, sleep(1_000)]);
      const output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      child.stdout?.destroy();
      child.stderr?.destroy();
      receiptStream?.destroy();
      // No exit code and no signal: the supervisor refused before starting the command.
      const parsed = lastReceipt(receipt);
      if (!parsed?.confirmed) { reject(Object.assign(new Error('The command processes could not be confirmed stopped.'), output)); return; }
      if (!killed && !parsed.started) { reject(new ConfinementUnavailable()); return; }
      if (code === 0 && !killed) { resolve(output); return; }
      reject(Object.assign(new Error(`Command failed: ${command.slice(-1)[0] ?? ''}`), {
        code, signal: killed ? 'SIGTERM' : signal, killed, ...output }));
    });
  });
}

/**
 * Runs one host process over lane content (#3414) with the confinement lane
 * commands get (#3412): no network, writes only under `root` (never its
 * `.git`) and a private TMPDIR, and on macOS no reads of the o8 data
 * directory. TMPDIR and the npm, XDG and jiti caches point into that temp
 * dir, which is removed afterwards.
 *
 * Where confinement is unavailable on this host (Windows, an old kernel, a
 * missing helper on Linux) the process still runs, unconfined, and the result carries
 * `unconfined: true` so callers can say so. A failure carries `code`,
 * `stdout`, `stderr` and `unconfined` like `execFile`. On macOS the supervisor
 * ends descendants whether or not confinement applies; a source checkout
 * without the helper keeps the `sandbox-exec` confinement but not that teardown.
 */
export async function runConfinedProcess(root: string, file: string, args: string[],
  options: ConfinedRunOptions): Promise<ConfinedRunResult> {
  const tmp = await mkdtemp(join(await realpath(tmpdir()), 'o8-confined-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, XDG_CACHE_HOME: join(tmp, 'cache'),
    npm_config_cache: join(tmp, 'npm'), npm_config_update_notifier: 'false', JITI_FS_CACHE: join(tmp, 'jiti') };
  const execOptions = { cwd: options.cwd, env, timeout: options.timeout, maxBuffer: options.maxBuffer, windowsHide: true };
  const unconfined = async () => {
    try {
      const helper = process.platform === 'darwin' ? supervisorPath() : null;
      const output = helper
        ? await runSupervised([helper, 'supervise', String(process.pid), '/bin/sh', '-c', 'exec "$0" "$@"', file, ...args], options, env)
        : await materializationAwareExecFile(file, args, execOptions);
      return { ...output, unconfined: true };
    } catch (error) {
      throw Object.assign(error as Error, { unconfined: true });
    }
  };
  try {
    const launch = await confinedPrefix(root, tmp);
    if (!launch) return await unconfined();
    try {
      // The supervisor execs an absolute path; the shell resolves `file` on PATH.
      const output = launch.supervised
        ? await runSupervised([...launch.prefix, '/bin/sh', '-c', 'exec "$0" "$@"', file, ...args], options, env)
        : await materializationAwareExecFile(launch.prefix[0], [...launch.prefix.slice(1), file, ...args], execOptions);
      return { ...output, unconfined: false };
    } catch (error) {
      // Nothing started, so running it unconfined (and saying so) is the fallback.
      if (error instanceof ConfinementUnavailable) return await unconfined();
      throw error;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** True when a `runConfinedProcess` result or failure ran without confinement. */
export function ranUnconfined(outcome: unknown): boolean {
  return typeof outcome === 'object' && outcome !== null && (outcome as { unconfined?: unknown }).unconfined === true;
}
