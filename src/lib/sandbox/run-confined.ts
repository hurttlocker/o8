import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { piWriteHelperPath } from '@/lib/pi/sdk/scripts';
import { materializationAwareExecFile, materializationAwareInvocation } from '@/lib/worktree/materialization-execution';
import { confinementArgs, ConfinementUnavailable } from './confine';

export interface ConfinedRunOptions { cwd: string; timeout: number; maxBuffer: number }
export interface ConfinedRunResult { stdout: string; stderr: string; unconfined: boolean }

/** The sandbox prefix for this host, or null when confinement is unavailable. */
async function confinedPrefix(root: string, tmp: string): Promise<string[] | null> {
  try {
    const args = await confinementArgs(await realpath(root), tmp);
    return process.platform === 'linux' ? [piWriteHelperPath(), 'supervise', ...args, String(process.pid)] : args;
  } catch {
    return null;
  }
}

function lastReceipt(text: string): { started: boolean } | null {
  try {
    const receipt = JSON.parse(text.trim().split('\n').at(-1) ?? '') as { code?: unknown; signal?: unknown };
    return { started: receipt.code != null || receipt.signal != null };
  } catch { return null; }
}

/**
 * Linux: the pi-write supervisor applies Landlock, runs the command, ends every
 * descendant, and reports on fd 3. SIGTERM asks it to tear the tree down.
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
    const stop = () => { if (!killed) { killed = true; child.kill('SIGTERM'); } };
    const take = (into: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBuffer) { stop(); return; }
      into.push(chunk);
    };
    child.stdout?.on('data', take(stdout));
    child.stderr?.on('data', take(stderr));
    (child.stdio[3] as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
      if (receipt.length < 4096) receipt += chunk.toString('utf8');
    });
    const timer = setTimeout(stop, options.timeout);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const output = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      // No exit code and no signal: the supervisor refused before starting the command.
      if (!killed && lastReceipt(receipt)?.started === false) { reject(new ConfinementUnavailable()); return; }
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
 * missing helper) the process still runs, unconfined, and the result carries
 * `unconfined: true` so callers can say so. A failure carries `code`,
 * `stdout`, `stderr` and `unconfined` like `execFile`.
 */
export async function runConfinedProcess(root: string, file: string, args: string[],
  options: ConfinedRunOptions): Promise<ConfinedRunResult> {
  const tmp = await mkdtemp(join(await realpath(tmpdir()), 'o8-confined-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, XDG_CACHE_HOME: join(tmp, 'cache'),
    npm_config_cache: join(tmp, 'npm'), npm_config_update_notifier: 'false', JITI_FS_CACHE: join(tmp, 'jiti') };
  const execOptions = { cwd: options.cwd, env, timeout: options.timeout, maxBuffer: options.maxBuffer, windowsHide: true };
  const unconfined = async () => {
    try {
      return { ...await materializationAwareExecFile(file, args, execOptions), unconfined: true };
    } catch (error) {
      throw Object.assign(error as Error, { unconfined: true });
    }
  };
  try {
    const prefix = await confinedPrefix(root, tmp);
    if (!prefix) return await unconfined();
    try {
      const output = process.platform === 'linux'
        // The supervisor execs an absolute path; the shell resolves `file` on PATH.
        ? await runSupervised([...prefix, '/bin/sh', '-c', 'exec "$0" "$@"', file, ...args], options, env)
        : await materializationAwareExecFile(prefix[0], [...prefix.slice(1), file, ...args], execOptions);
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
