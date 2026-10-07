import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

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

interface ProcessRow { pid: number; ppid: number; pgid: number }

function listProcesses(): Promise<ProcessRow[]> {
  return new Promise(resolve => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', timeout: 5_000 }, (_error, stdout) => {
      resolve((stdout ?? '').split('\n').flatMap(line => {
        const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
        // Zombies are already dead and only wait to be reaped.
        if (!pid || stat?.startsWith('Z')) return [];
        return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) }];
      }));
    });
  });
}

/** The command's process group plus every live descendant, including children that started their own group. */
async function processTree(leader: number): Promise<number[]> {
  const rows = await listProcesses();
  // Group membership, not the leader pid: once the shell is reaped its pid can be reused.
  const tree = new Set(rows.filter(row => row.pgid === leader).map(row => row.pid));
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true; }
    }
  }
  tree.delete(process.pid);
  return [...tree];
}

function signal(pids: number[], leader: number, name: NodeJS.Signals) {
  try { process.kill(-leader, name); } catch { /* The group may already be empty. */ }
  for (const pid of pids) { try { process.kill(pid, name); } catch { /* Already gone. */ } }
}

/**
 * Ends the group and its descendants: TERM, a short grace period, then KILL.
 * A process that detaches into a new session and is reparented before this runs
 * is outside the tree; see docs/internals/pi-sdk-prototype.md.
 */
export async function endPiCommandTree(leader: number) {
  signal(await processTree(leader), leader, 'SIGTERM');
  for (let waited = 0; waited < 1_500; waited += 100) {
    if (!(await processTree(leader)).length) return;
    await sleep(100);
  }
  signal(await processTree(leader), leader, 'SIGKILL');
  for (let waited = 0; waited < 2_000 && (await processTree(leader)).length; waited += 100) await sleep(100);
}

export interface PiCommandOptions { timeoutMs?: number; maxOutputBytes?: number }

/**
 * Runs one approved command at the workspace root. Stdout and stderr share one
 * capped buffer. Timeout, the output cap and Stop each end the whole tree, and
 * so does a normal exit, so no background process outlives the tool call.
 */
export async function runPiCommand(root: string, command: string, abort: AbortSignal, options: PiCommandOptions = {}) {
  abort.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? PI_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? PI_COMMAND_OUTPUT_BYTES;
  const child = spawn('/bin/sh', ['-c', command], { cwd: root, env: piCommandEnv(), detached: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; error?: boolean }>(resolve => {
    child.once('exit', code => resolve({ code }));
    child.once('error', () => resolve({ code: null, error: true }));
  });
  const chunks: Buffer[] = [];
  let size = 0;
  let stopped: 'timeout' | 'output' | 'stop' | undefined;
  const stop = (reason: NonNullable<typeof stopped>) => {
    if (stopped || !child.pid) return;
    stopped = reason;
    void endPiCommandTree(child.pid);
  };
  const take = (chunk: Buffer) => {
    const room = maxOutputBytes - size;
    if (room <= 0) return;
    chunks.push(chunk.subarray(0, room));
    size += Math.min(room, chunk.length);
    if (chunk.length > room) stop('output');
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const onAbort = () => stop('stop');
  abort.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await exited;
    if (child.pid) await endPiCommandTree(child.pid);
    abort.throwIfAborted();
    if (result.error) throw new Error('Command could not start');
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
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
