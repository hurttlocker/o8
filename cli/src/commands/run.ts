/**
 * `o8 run [--detach] [--] <cmd...>` — run a process inside an o8-owned tmux
 * session so the operator can attach a LIVE raw-stdout terminal and watch it.
 *
 * Why tmux: a bare-exec'd child's stdout flows into the agent's own pipe with
 * no retroactive tap (no /proc on macOS, SIP blocks dtrace). o8 must OWN the
 * PTY at spawn. The command runs in `cortex-run-<id>`; the bottom panel attaches
 * to that session = raw stdout. The same session ties listening ports to the
 * run (cwd cross-ref), so the footer can offer a "watch live" chip.
 *
 * Default (stream): the CLI mirrors the pane to its OWN stdout and blocks until
 * the command exits, so the agent sees output exactly as if it ran the command
 * directly. `--detach` fire-and-registers and returns immediately (servers).
 * `o8 run stop <runId>` kills a registered managed run.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  writeFileSync,
  rmSync,
  fstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiFetch, CliError, EXIT } from '../api.js';
import { resolveConfig } from '../config.js';
import { resolveLaneFromCwd } from './packet/worktree-resolve.js';
import { printJson, printHumanHeading, printHumanKv, type OutputMode } from '../output.js';

/** Flags consumed by `o8 run` itself (everything else is the command). */
const RUN_LEADING_FLAGS = new Set([
  '--detach',
  '--list',
  '--human',
  '--json',
  '--verbose',
  '-v',
  '--help',
  '-h',
]);

/** env vars that must NOT leak into the pane (confuse tmux / cwd). */
const ENV_DENYLIST = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL', 'TMUX', 'TMUX_PANE']);

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** single-quote a value for safe interpolation into an `sh -c` string. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function liveMarkerPids(marker: string): number[] | null {
  if (process.platform === 'win32') return null;
  try {
    const output = execFileSync('ps', ['eww', '-axo', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    });
    const needle = `O8_MANAGED_RUN_MARKER=${marker}`;
    return output.split('\n').flatMap((line) => {
      if (!line.includes(needle)) return [];
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? '', 10);
      return Number.isSafeInteger(pid) && pid > 0 ? [pid] : [];
    });
  } catch {
    return null;
  }
}

function liveSessionProcessGroup(session: string, expected: number | null): number | null {
  if (process.platform === 'win32') return null;
  try {
    execFileSync('tmux', ['has-session', '-t', session], {
      timeout: 3_000,
      windowsHide: true,
      stdio: 'ignore',
    });
    const panePid = Number.parseInt(execFileSync(
      'tmux',
      ['list-panes', '-t', session, '-F', '#{pane_pid}'],
      { encoding: 'utf8', timeout: 3_000, windowsHide: true },
    ).trim(), 10);
    const group = Number.parseInt(execFileSync(
      'ps',
      ['-o', 'pgid=', '-p', String(panePid)],
      { encoding: 'utf8', timeout: 2_000, windowsHide: true },
    ).trim(), 10);
    if (!Number.isSafeInteger(group) || group <= 0) return null;
    return expected && expected !== group ? null : group;
  } catch {
    return null;
  }
}

function ownedSessionAlive(session: string): boolean {
  try {
    execFileSync('tmux', ['has-session', '-t', session], {
      timeout: 3_000,
      windowsHide: true,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function settleOwnedSessionLocally(
  session: string,
  processGroupId: number | null,
  marker: string,
): Promise<boolean> {
  for (const [signal, waitMs] of [
    ['SIGINT', 800],
    ['SIGTERM', 1_200],
    ['SIGKILL', 1_500],
  ] as const) {
    const currentGroup = liveSessionProcessGroup(session, processGroupId);
    if (currentGroup) {
      try { process.kill(-currentGroup, signal); } catch {}
    }
    for (const pid of liveMarkerPids(marker) ?? []) {
      try { process.kill(pid, signal); } catch {}
    }
    if (signal === 'SIGKILL') {
      try {
        execFileSync('tmux', ['kill-session', '-t', session], {
          timeout: 5_000,
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {}
    }
    await sleep(waitMs);
    const remaining = liveMarkerPids(marker);
    if (!ownedSessionAlive(session)
      && remaining !== null
      && remaining.length === 0) return true;
  }
  const remaining = liveMarkerPids(marker);
  return !ownedSessionAlive(session)
    && remaining !== null
    && remaining.length === 0;
}

/**
 * Pull the command out of the RAW argv. The shared dispatcher greedily eats the
 * first two bare tokens as command words, so it can't be trusted to carry an
 * arbitrary command — re-parse from process.argv. Supports both
 * `o8 run <cmd...>` and `o8 run [--detach] -- <cmd...>`.
 */
function extractRunCommand(): { detach: boolean; list: boolean; command: string[] } {
  const argv = process.argv.slice(2);
  const runIdx = argv.indexOf('run');
  const after = runIdx >= 0 ? argv.slice(runIdx + 1) : [];

  const dashIdx = after.indexOf('--');
  let flags: string[];
  let command: string[];
  if (dashIdx >= 0) {
    flags = after.slice(0, dashIdx);
    command = after.slice(dashIdx + 1);
  } else {
    flags = [];
    let i = 0;
    while (i < after.length && after[i].startsWith('-') && RUN_LEADING_FLAGS.has(after[i])) {
      flags.push(after[i]);
      i += 1;
    }
    command = after.slice(i);
  }
  return { detach: flags.includes('--detach'), list: flags.includes('--list'), command };
}

interface ManagedRunRow {
  id: string;
  session: string;
  command: string;
  status: 'running' | 'finished' | 'gone' | 'killed';
  startedAt?: string;
  exitCode?: number | null;
  mode?: string;
}

export function parseRunStopArgs(command: string[]): { runId: string } {
  if (command[0] !== 'stop') {
    throw new CliError('invalid_args', 'Expected run stop command.', EXIT.INVALID_ARGS);
  }
  const runId = command[1]?.trim();
  if (!runId) {
    throw new CliError(
      'invalid_args',
      'o8 run stop requires a run id.',
      EXIT.INVALID_ARGS,
      'Use `o8 run --list`, then run `o8 run stop <id>`.',
    );
  }
  if (command.length > 2) {
    throw new CliError(
      'invalid_args',
      `Unexpected run stop arguments: ${command.slice(2).join(' ')}`,
      EXIT.INVALID_ARGS,
      'usage: o8 run stop <runId>',
    );
  }
  return { runId };
}

/** `o8 run --list` — show managed runs (running + recent finished w/ exit codes). */
async function runRunList(mode: OutputMode): Promise<number> {
  const cfg = resolveConfig();
  const res = await apiFetch<{ runs?: ManagedRunRow[] }>(cfg, '/api/panel/managed-runs');
  const runs = res.data?.runs ?? [];
  if (mode.human) {
    printHumanHeading(`o8 runs (${cfg.apiBase})`);
    if (runs.length === 0) {
      process.stdout.write('  (no managed runs)\n');
    } else {
      printHumanKv(runs.map((r) => [
        r.session,
        `${r.status}${typeof r.exitCode === 'number' ? ` (exit ${r.exitCode})` : ''} · ${r.command}`,
      ]));
    }
  } else {
    printJson({ schema: 'o8/cli/run-list/v1', runs });
  }
  return 0;
}

async function runRunStop(mode: OutputMode, command: string[]): Promise<number> {
  const { runId } = parseRunStopArgs(command);
  const cfg = resolveConfig();
  const listRes = await apiFetch<{ runs?: ManagedRunRow[] }>(cfg, '/api/panel/managed-runs');
  const run = (listRes.data?.runs ?? []).find((candidate) => (
    candidate.id === runId || candidate.session === runId
  ));
  if (!run) {
    throw new CliError(
      'run_not_found',
      `No managed run found for ${runId}.`,
      EXIT.NOT_FOUND,
      'Run `o8 run --list` to see current managed runs.',
    );
  }
  const stopRes = await apiFetch<{ ok?: boolean; run?: ManagedRunRow; error?: string }>(cfg, '/api/panel/managed-runs', {
    method: 'POST',
    body: { action: 'kill', session: run.session },
  });
  if (!stopRes.data?.ok) {
    throw new CliError('run_stop_failed', stopRes.data?.error || `Run ${runId} could not be stopped.`, EXIT.CONFLICT);
  }

  const payload = {
    schema: 'o8/cli/run.stop/v1',
    run: stopRes.data.run ?? run,
  };
  if (mode.human) {
    const stopped = stopRes.data.run ?? run;
    printHumanHeading('run stop');
    printHumanKv([
      ['id', stopped.id],
      ['session', stopped.session],
      ['status', stopped.status],
      ['command', stopped.command],
    ]);
  } else {
    printJson(payload);
  }
  return 0;
}

export async function runRun(mode: OutputMode, _rest: string[]): Promise<number> {
  void _rest; // the command comes from raw argv, not the dispatcher's parse
  const { detach, list, command } = extractRunCommand();

  if (list) return runRunList(mode);
  if (command[0] === 'stop') return runRunStop(mode, command);

  if (command.length === 0) {
    throw new CliError(
      'no_command',
      'o8 run needs a command to execute.',
      EXIT.INVALID_ARGS,
      'usage: o8 run [--detach] [--] <command...>   e.g. o8 run python backtest.py',
    );
  }

  const id = randomUUID().replace(/-/g, '').slice(0, 8);
  const session = `cortex-run-${id}`;
  const cwd = process.cwd();
  const cmd = command.join(' ');
  const startedAt = new Date().toISOString();
  const processMarker = randomUUID().replace(/-/g, '');

  const base = join(tmpdir(), `o8-run-${id}`);
  const logFile = `${base}.log`;
  const exitFile = `${base}.exit`;
  const goFile = `${base}.go`;
  const envFile = `${base}.env`;
  for (const f of [logFile, exitFile, goFile, envFile]) {
    try { rmSync(f, { force: true }); } catch { /* fresh paths */ }
  }

  // Mirror the agent's full env into the pane (the tmux server may have stale
  // env — at minimum PATH would be wrong → "command not found").
  const envLines: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue;
    if (ENV_DENYLIST.has(k)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    envLines.push(`export ${k}=${sq(v)}`);
  }
  envLines.push(`export O8_MANAGED_RUN_MARKER=${sq(processMarker)}`);
  // Mode 0600 — the env-file mirrors the agent's full environment (incl.
  // O8_API_TOKEN + provider keys) into shared /tmp; never world-readable.
  try { writeFileSync(envFile, envLines.join('\n'), { mode: 0o600 }); } catch { /* best effort */ }

  // A go-gate guarantees pipe-pane is attached before the command emits output,
  // so nothing is missed (matters for short commands). The command runs via
  // `"$@"` (tokens passed as positional args) so quoting survives intact — a
  // joined-and-reshelled string would mangle anything with shell metachars.
  // A `trap ... EXIT` removes the secret-bearing env-file + go-file
  // unconditionally — even if `cd` fails or the command is killed mid-run.
  const wrapper = [
    `trap 'rm -f ${sq(goFile)} ${sq(envFile)}' EXIT`,
    `cd ${sq(cwd)} || exit 1`,
    `[ -e ${sq(envFile)} ] && . ${sq(envFile)}`,
    `rm -f ${sq(envFile)}`,
    `printf '$ %s\\nstarted-at %s\\n\\n' "$*" ${sq(startedAt)}`,
    `while [ ! -e ${sq(goFile)} ]; do sleep 0.02; done`,
    `"$@"`,
    `__o8_ec=$?`,
    `printf '%s' "$__o8_ec" > ${sq(exitFile)}`,
    `exit $__o8_ec`,
  ].join('; ');

  try {
    execFileSync(
      'tmux',
      ['new-session', '-d', '-s', session, '-x', '220', '-y', '50', 'sh', '-c', wrapper, 'o8run', ...command],
      { windowsHide: true, timeout: 10_000, stdio: 'ignore' },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CliError(
      'tmux_spawn_failed',
      `Could not start tmux session: ${msg}`,
      EXIT.INVALID_ARGS,
      'o8 run needs tmux on PATH to own the process PTY. Install tmux (brew install tmux).',
    );
  }

  // Capture the pane pid (the server attributes ports to runs via pane-pid
  // ancestry — needed in BOTH modes).
  let panePid: number | null = null;
  try {
    const out = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      windowsHide: true,
      encoding: 'utf-8',
      timeout: 3_000,
    }).trim();
    panePid = Number.parseInt(out, 10) || null;
  } catch { /* informational only */ }
  let processGroupId: number | null = null;
  if (panePid && process.platform !== 'win32') {
    try {
      const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(panePid)], {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 2_000,
      }).trim();
      processGroupId = Number.parseInt(out, 10) || null;
    } catch { /* the exact tmux session remains the ownership authority */ }
  }

  let interruptRequested = false;
  const onSigint = () => {
    interruptRequested = true;
  };
  if (!detach) process.on('SIGINT', onSigint);

  // Only stream mode needs the pane teed to a log file (we tail it to stdout).
  // Detached runs are watched by attaching the tmux session directly, so piping
  // would just grow an unbounded /tmp log nobody reads.
  if (!detach) {
    try {
      execFileSync('tmux', ['pipe-pane', '-o', '-t', session, `cat >> ${sq(logFile)}`], {
        windowsHide: true,
        timeout: 5_000,
        stdio: 'ignore',
      });
    } catch { /* without pipe-pane the operator can still attach live; agent just won't see stream */ }
  }

  try {
    writeFileSync(goFile, ''); // release — command starts now
  } catch (error) {
    process.off('SIGINT', onSigint);
    try {
      execFileSync('tmux', ['kill-session', '-t', session], {
        windowsHide: true,
        timeout: 5_000,
        stdio: 'ignore',
      });
    } catch {}
    for (const f of [logFile, exitFile, goFile, envFile]) {
      try { rmSync(f, { force: true }); } catch {}
    }
    throw error;
  }

  // Resolve packet context (best effort) and register the run (soft — a down
  // server must not block the agent's work; the command still runs in tmux).
  const cfg = resolveConfig();
  let packetId: string | null = null;
  let laneId: string | null = null;
  try {
    const lane = await resolveLaneFromCwd();
    if (lane) {
      packetId = lane.packetId;
      laneId = lane.laneId;
    }
  } catch { /* not in a packet worktree, or lanes API hiccup */ }

  let registered = false;
  try {
    const res = await apiFetch<{ ok?: boolean }>(cfg, '/api/panel/managed-runs', {
      method: 'POST',
      body: {
        action: 'register',
        id,
        session,
        command: cmd,
        cwd,
        packetId,
        laneId,
        panePid,
        processGroupId,
        processMarker,
        mode: detach ? 'detach' : 'stream',
        startedAt,
      },
    });
    registered = Boolean(res.data?.ok);
  } catch { /* server unreachable — degrade to run-without-visibility */ }

  if (detach) {
    if (mode.human) {
      printHumanHeading(`o8 run (detached) — ${session}`);
      printHumanKv([
        ['command', cmd],
        ['cwd', cwd],
        ['session', session],
        ['watchable', registered ? 'yes (o8 ports menu → Agent)' : 'no (o8 server unreachable)'],
      ]);
    } else {
      printJson({
        schema: 'o8/cli/run/v1',
        mode: 'detach',
        id,
        session,
        command: cmd,
        cwd,
        packetId,
        laneId,
        registered,
      });
    }
    return 0;
  }

  // Stream mode: this CLI's stdout IS the command's output. o8 metadata → stderr.
  process.stderr.write(`[o8 run] ${session} — watch live in o8 (ports menu → Agent)\n`);

  let fd: number | null = null;
  let pos = 0;
  const pump = () => {
    if (fd === null) {
      if (!existsSync(logFile)) return;
      try { fd = openSync(logFile, 'r'); } catch { fd = null; return; }
    }
    try {
      const size = fstatSync(fd).size;
      if (size <= pos) return;
      const len = size - pos;
      const buf = Buffer.allocUnsafe(len);
      const n = readSync(fd, buf, 0, len, pos);
      if (n > 0) {
        process.stdout.write(buf.subarray(0, n));
        pos += n;
      }
    } catch { /* transient read race — retry next tick */ }
  };
  const sessionAlive = (): boolean => {
    try {
      execFileSync('tmux', ['has-session', '-t', session], { windowsHide: true, timeout: 3_000, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  let tick = 0;
  let exitFound = false;
  let exitCode = 0;
  try {
    for (;;) {
      pump();
      if (existsSync(exitFile)) { exitFound = true; break; }
      if (interruptRequested) {
        let confirmed = false;
        if (registered) {
          try {
            const response = await apiFetch<{ ok?: boolean }>(cfg, '/api/panel/managed-runs', {
              method: 'POST',
              body: { action: 'kill', session, reason: 'stream_sigint', exitCode: 130 },
            });
            confirmed = response.data?.ok === true;
          } catch { /* fall through to the same local ownership proof */ }
        }
        if (!confirmed) {
          confirmed = await settleOwnedSessionLocally(session, processGroupId, processMarker);
          if (confirmed && registered) {
            try {
              const response = await apiFetch<{ ok?: boolean }>(cfg, '/api/panel/managed-runs', {
                method: 'POST',
                body: { action: 'kill', session, reason: 'stream_sigint', exitCode: 130 },
              });
              confirmed = response.data?.ok === true;
            } catch { /* local proof still prevents an orphan */ }
          }
        }
        if (!confirmed) {
          throw new CliError(
            'run_interrupt_unsettled',
            `Interrupted run ${session}, but its complete process tree could not be confirmed stopped.`,
            EXIT.CONFLICT,
          );
        }
        exitCode = 130;
        break;
      }
      tick += 1;
      // Fallback (~2s): session vanished without writing exit = killed externally.
      if (tick % 13 === 0 && !sessionAlive()) break;
      await sleep(150);
    }
    // Final drain — pipe-pane's `cat` flushes async; keep pumping until the log
    // stops growing (no new bytes across two reads) or a ~1.5s cap, so an agent
    // parsing this captured stdout isn't truncated vs the live tmux view.
    for (let i = 0, stable = 0; i < 30 && stable < 2; i += 1) {
      const before = pos;
      await sleep(50);
      pump();
      stable = pos === before ? stable + 1 : 0;
    }

    if (!interruptRequested) {
      if (exitFound) {
        try {
          const parsed = Number.parseInt(readFileSync(exitFile, 'utf-8').trim(), 10);
          exitCode = Number.isNaN(parsed) ? 0 : parsed;
        } catch { exitCode = 0; }
      } else {
        exitCode = 130; // session killed out from under us
      }
      try {
        await apiFetch(cfg, '/api/panel/managed-runs', {
          method: 'POST',
          body: { action: 'finish', session, exitCode },
        });
      } catch { /* best effort */ }
    }

    process.stderr.write(`[o8 run] ${session} exited ${exitCode}\n`);
    return exitCode;
  } finally {
    process.off('SIGINT', onSigint);
    if (fd !== null) { try { closeSync(fd); } catch { /* noop */ } }
    for (const f of [logFile, exitFile, goFile, envFile]) {
      try { rmSync(f, { force: true }); } catch { /* noop */ }
    }
  }
}
