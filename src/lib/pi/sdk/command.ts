import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { confinementArgs, ConfinementUnavailable } from '@/lib/sandbox/confine';
import { piWriteHelperPath } from './scripts';

export const PI_COMMAND_OUTPUT_BYTES = 50_000;
export const PI_COMMAND_TIMEOUT_MS = 120_000;
export const PI_COMMAND_MAX_BYTES = 10_000;

// Allowlist, not a denylist: no provider keys, host tokens, o8 internals or the
// SSH agent socket reach a command, whatever names they use.
const INHERITED_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR'] as const;

export function piCommandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
  for (const key of INHERITED_ENV) if (source[key]) env[key] = source[key];
  return { ...env, TERM: 'dumb', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' };
}

let exclusiveTail: Promise<unknown> = Promise.resolve();
/**
 * One command or approved-write commit at a time across every Pi session in this
 * host, so no command process is alive while any approved write commits. A call
 * still waiting for its turn ends on abort without running; later calls keep
 * waiting for the work ahead of it.
 */
export function withPiExclusive<T>(work: () => Promise<T>, abort?: AbortSignal): Promise<T> {
  const ahead = exclusiveTail;
  let release!: () => void;
  const finished = new Promise<void>(resolve => { release = resolve; });
  exclusiveTail = ahead.then(() => finished);
  const stopped = new Promise<never>((_resolve, reject) => {
    if (!abort) return;
    const onAbort = () => reject(abort.reason ?? new Error('Stopped'));
    if (abort.aborted) onAbort(); else abort.addEventListener('abort', onAbort, { once: true });
    void ahead.then(() => abort.removeEventListener('abort', onAbort));
  });
  stopped.catch(() => {});
  return Promise.race([ahead, stopped])
    .then(() => { abort?.throwIfAborted(); return work(); })
    .finally(release);
}

let cleanupUnconfirmed = false;
/** Set when a command's processes could not be confirmed stopped; commands and writes stay refused until restart. */
export function piCommandCleanupUnconfirmed() { return cleanupUnconfirmed; }

export interface PiCommandOptions {
  timeoutMs?: number; maxOutputBytes?: number;
  /** Lane rules (#3385): no network, and writes only in the workspace and a private temp dir. Host-set only. */
  confined?: boolean;
}

// The outer shell checks that its working directory is still the workspace
// before it runs the command, so a root swapped for a symlink after the host's
// checks is refused. The command gets a fresh shell with no positional arguments.
const LAUNCHER = '[ "$(pwd -P)" = "$1" ] || { echo "The workspace changed before the command started." >&2; exit 126; }; exec /bin/sh -c "$2"';

/** The native supervisor ends tracked descendants and reports teardown on fd 3. */
const SUPERVISOR_EXIT_MS = 10_000;

function parseReceipt(text: string): { confirmed: boolean; started: boolean } | null {
  try {
    const receipt = JSON.parse(text.trim().split('\n').at(-1) ?? '') as { confirmed?: unknown; code?: unknown; signal?: unknown };
    // No exit code and no signal: the supervisor refused before starting the command.
    return { confirmed: receipt.confirmed === true, started: receipt.code != null || receipt.signal != null };
  } catch { return null; }
}

/** Resolves when a stream has delivered everything, or at once if there is none. */
function drained(stream: NodeJS.ReadableStream | null | undefined): Promise<void> {
  return new Promise(resolve => {
    if (!stream || (stream as { readableEnded?: boolean }).readableEnded) { resolve(); return; }
    stream.once('end', () => resolve());
    stream.once('close', () => resolve());
    stream.once('error', () => resolve());
  });
}

/**
 * Runs one approved command at the workspace root. Stdout and stderr share one
 * capped buffer. Timeout, the output cap, Stop and a normal exit each end the
 * command's processes. The native supervisor uses a Linux subreaper or macOS
 * kqueue process events to track descendants, including ones in new sessions.
 *
 * With `confined`, the command runs confined and its TMPDIR is a fresh directory
 * removed afterwards. When confinement cannot be applied it throws
 * `ConfinementUnavailable` and nothing has started.
 */
export async function runPiCommand(root: string, command: string, abort: AbortSignal, options: PiCommandOptions = {}) {
  if (!options.confined) return runCommand(root, command, abort, options);
  abort.throwIfAborted();
  const tmp = await mkdtemp(join(await realpath(tmpdir()), 'o8-pi-command-'));
  try {
    return await runCommand(root, command, abort, options, { tmp, args: await confinementArgs(root, tmp) });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function runCommand(root: string, command: string, abort: AbortSignal, options: PiCommandOptions,
  confined?: { tmp: string; args: string[] }) {
  abort.throwIfAborted();
  if (cleanupUnconfirmed) throw new Error('Earlier command processes could not be confirmed stopped. Restart o8 before running more commands.');
  const timeoutMs = options.timeoutMs ?? PI_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? PI_COMMAND_OUTPUT_BYTES;
  const env = confined ? { ...piCommandEnv(), TMPDIR: confined.tmp } : piCommandEnv();
  // On macOS the confinement is a `sandbox-exec` prefix; on Linux, supervisor arguments.
  const linux = process.platform === 'linux';
  const launch = [...(confined && !linux ? confined.args : []), '/bin/sh', '-c', LAUNCHER, 'o8-pi-command', root, command];
  const child = spawn(piWriteHelperPath(), ['supervise', ...(linux ? confined?.args ?? [] : []), String(process.pid), ...launch],
    { cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  let hasExited = false;
  const exited = new Promise<{ code: number | null; error?: boolean }>(resolve => {
    child.once('exit', code => { hasExited = true; resolve({ code }); });
    child.once('error', () => { hasExited = true; resolve({ code: null, error: true }); });
  });
  let receipt = '';
  const receiptStream = child.stdio[3] as NodeJS.ReadableStream | null;
  const receiptRead = new Promise<void>(resolve => {
    if (!receiptStream) { resolve(); return; }
    receiptStream.on('data', (chunk: Buffer) => { if (receipt.length < 4096) receipt += chunk.toString('utf8'); });
    receiptStream.once('end', () => resolve());
    receiptStream.once('error', () => resolve());
  });
  const endSupervised = async () => {
    // Never signal a pid after its exit: it may already belong to someone else.
    if (!hasExited && child.pid) { try { process.kill(child.pid, 'SIGTERM'); } catch { /* Exited meanwhile. */ } }
    const finished = await Promise.race([exited.then(() => true), sleep(SUPERVISOR_EXIT_MS).then(() => false)]);
    if (!finished) {
      if (child.pid) for (const target of [-child.pid, child.pid]) { try { process.kill(target, 'SIGKILL'); } catch { /* Gone. */ } }
      return false;
    }
    await Promise.race([receiptRead, sleep(1_000)]);
    const parsed = parseReceipt(receipt);
    notStarted = parsed?.started === false;
    return parsed?.confirmed === true;
  };
  let notStarted = false;
  let teardown: Promise<boolean> | undefined;
  const endTree = () => (teardown ??= endSupervised());
  const chunks: Buffer[] = [];
  let size = 0;
  let stopped: 'timeout' | 'output' | 'stop' | undefined;
  let stopRequested!: () => void;
  const stopping = new Promise<void>(resolve => { stopRequested = resolve; });
  const stop = (reason: NonNullable<typeof stopped>) => {
    if (stopped) return;
    stopped = reason;
    stopRequested();
    void endTree();
  };
  const take = (chunk: Buffer) => {
    if (!chunk.length) return;
    const room = maxOutputBytes - size;
    if (room <= 0) { stop('output'); return; }
    chunks.push(chunk.subarray(0, room));
    size += Math.min(room, chunk.length);
    if (chunk.length > room) stop('output');
  };
  child.stdout?.on('data', take);
  child.stderr?.on('data', take);
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const onAbort = () => stop('stop');
  abort.addEventListener('abort', onAbort, { once: true });
  try {
    // A process that cannot be killed (for example in uninterruptible sleep)
    // must not hold the call open: once a stop's teardown fails, stop waiting.
    const result = await Promise.race([exited,
      stopping.then(endTree).then(ended => (ended ? exited : { code: null, error: false, lost: true }))]);
    if (!await endTree()) {
      cleanupUnconfirmed = true;
      throw new Error('The command processes could not be confirmed stopped. Restart o8 before running more commands.');
    }
    abort.throwIfAborted();
    // A confined command the supervisor refused to start never ran unconfined.
    if (confined && notStarted) throw new ConfinementUnavailable();
    if (result.error || notStarted) throw new Error('Command could not start');
    // Exit can arrive before the last buffered output; with no writer left, the
    // pipes end promptly.
    await Promise.race([Promise.all([drained(child.stdout), drained(child.stderr)]), sleep(1_000)]);
    // A Stop that arrived while draining still cancels the call.
    abort.throwIfAborted();
    const output = Buffer.concat(chunks).toString('utf8');
    const status = stopped === 'timeout'
      ? `The command was stopped after ${Math.round(timeoutMs / 1000)} second${timeoutMs === 1000 ? '' : 's'}.`
      : stopped === 'output'
        ? `The command produced more than ${maxOutputBytes} bytes of output and was stopped.`
        : `Exit code ${result.code ?? 'unknown'}`;
    return `$ ${command}\n${status}\n\n${output || '(no output)'}`;
  } finally {
    clearTimeout(timer);
    abort.removeEventListener('abort', onAbort);
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
