import { execFile, spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export const PI_COMMAND_OUTPUT_BYTES = 50_000;
export const PI_COMMAND_TIMEOUT_MS = 120_000;
export const PI_COMMAND_MAX_BYTES = 10_000;
const TERM_GRACE_MS = 1_500;
const KILL_WAIT_MS = 2_000;
const TRACK_INTERVAL_MS = 250;

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

interface ProcessRow { pid: number; ppid: number; pgid: number; started: string }

/** Returns null when the process table cannot be read, never an empty table. */
function listProcesses(): Promise<ProcessRow[] | null> {
  return new Promise(resolve => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], { encoding: 'utf8', timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) { resolve(null); return; }
        const rows = (stdout ?? '').split('\n').flatMap(line => {
          const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
          // Zombies are already dead and only wait to be reaped.
          if (!match || match[4].startsWith('Z')) return [];
          return [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[5] }];
        });
        resolve(rows.some(row => row.pid === process.pid) ? rows : null);
      });
  });
}

/**
 * Tracks the command's process group and every descendant by pid and start
 * time. A process stays tracked after its parent dies and it is reparented, and
 * a pid whose start time changed belongs to someone else and is dropped.
 */
class CommandTree {
  private readonly tracked = new Map<number, ProcessRow>();
  private started = 0;
  private applied = 0;
  private inFlight = 0;
  /** Set once a readable table shows no member of the group; its number may then be reused. */
  private groupGone = false;
  constructor(private readonly leader: number) {}

  /**
   * Reads may overlap, so each is numbered and a result older than the last
   * one applied is dropped: a late snapshot never undoes what a newer one found.
   */
  async refresh(): Promise<boolean> {
    const sequence = ++this.started;
    this.inFlight++;
    try {
      const rows = await listProcesses();
      if (sequence < this.applied) return true;
      if (!rows) return false;
      this.applied = sequence;
      this.apply(rows);
      return true;
    } finally { this.inFlight--; }
  }

  /** For the periodic watch: a stalled read does not stop new ones, but reads do not pile up. */
  refreshIfIdle() { if (this.inFlight < 3) void this.refresh(); }

  private apply(rows: ProcessRow[]) {
    const live = new Map(rows.map(row => [row.pid, row]));
    for (const [pid, row] of this.tracked) {
      if (live.get(pid)?.started !== row.started) this.tracked.delete(pid);
    }
    if (!this.groupGone) {
      const members = rows.filter(row => row.pgid === this.leader && row.pid !== process.pid);
      if (!members.length) this.groupGone = true;
      for (const row of members) this.tracked.set(row.pid, row);
    }
    for (let grew = true; grew;) {
      grew = false;
      for (const row of rows) {
        if (!this.tracked.has(row.pid) && this.tracked.has(row.ppid)) { this.tracked.set(row.pid, row); grew = true; }
      }
    }
  }

  get empty() { return this.tracked.size === 0; }

  signal(name: NodeJS.Signals, groupUnverified: boolean) {
    // The group id is only signalled while a tracked member still holds it, or
    // when the table could not be read and the group was never seen empty.
    if (!this.groupGone && (groupUnverified || [...this.tracked.values()].some(row => row.pgid === this.leader))) {
      try { process.kill(-this.leader, name); } catch { /* The group is empty. */ }
    }
    for (const pid of this.tracked.keys()) { try { process.kill(pid, name); } catch { /* Already gone. */ } }
  }
}

/**
 * Ends the group and its descendants: TERM, a grace period, then KILL on a fixed
 * schedule whether or not the table can be read. Returns true only when an
 * readable process table confirms nothing tracked is left.
 */
async function endCommandTree(tree: CommandTree): Promise<boolean> {
  let readable = await tree.refresh();
  tree.signal('SIGTERM', !readable);
  const graceEnds = Date.now() + TERM_GRACE_MS;
  while (Date.now() < graceEnds) {
    await sleep(100);
    readable = await tree.refresh();
    if (readable && tree.empty) return true;
  }
  tree.signal('SIGKILL', !readable);
  const killEnds = Date.now() + KILL_WAIT_MS;
  while (Date.now() < killEnds) {
    await sleep(100);
    readable = await tree.refresh();
    if (readable && tree.empty) return true;
  }
  return false;
}

export interface PiCommandOptions { timeoutMs?: number; maxOutputBytes?: number }

// The outer shell checks that its working directory is still the workspace
// before it runs the command, so a root swapped for a symlink after the host's
// checks is refused. The command gets a fresh shell with no positional arguments.
const LAUNCHER = '[ "$(pwd -P)" = "$1" ] || { echo "The workspace changed before the command started." >&2; exit 126; }; exec /bin/sh -c "$2"';

/**
 * Runs one approved command at the workspace root. Stdout and stderr share one
 * capped buffer. Timeout, the output cap and Stop each end the whole tree, and
 * so does a normal exit, so no tracked process outlives the tool call.
 */
export async function runPiCommand(root: string, command: string, abort: AbortSignal, options: PiCommandOptions = {}) {
  abort.throwIfAborted();
  if (cleanupUnconfirmed) throw new Error('Earlier command processes could not be confirmed stopped. Restart o8 before running more commands.');
  const timeoutMs = options.timeoutMs ?? PI_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? PI_COMMAND_OUTPUT_BYTES;
  const child = spawn('/bin/sh', ['-c', LAUNCHER, 'o8-pi-command', root, command], { cwd: root, env: piCommandEnv(),
    detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; error?: boolean }>(resolve => {
    child.once('exit', code => resolve({ code }));
    child.once('error', () => resolve({ code: null, error: true }));
  });
  const tree = child.pid ? new CommandTree(child.pid) : null;
  let teardown: Promise<boolean> | undefined;
  const endTree = () => (teardown ??= tree ? endCommandTree(tree) : Promise.resolve(true));
  const chunks: Buffer[] = [];
  let size = 0;
  let stopped: 'timeout' | 'output' | 'stop' | undefined;
  const stop = (reason: NonNullable<typeof stopped>) => {
    if (stopped) return;
    stopped = reason;
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
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  // Track the tree while it runs, so a child that starts its own group is still
  // known after its parent exits and it is reparented.
  const watch = setInterval(() => { if (!teardown) tree?.refreshIfIdle(); }, TRACK_INTERVAL_MS);
  void tree?.refresh();
  const onAbort = () => stop('stop');
  abort.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await exited;
    if (!await endTree()) {
      cleanupUnconfirmed = true;
      throw new Error('The command processes could not be confirmed stopped. Restart o8 before running more commands.');
    }
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
    clearInterval(watch);
    abort.removeEventListener('abort', onAbort);
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
