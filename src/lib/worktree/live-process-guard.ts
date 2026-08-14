/**
 * Live-process guard for worktree pruning (#1585).
 *
 * The invariant the whole worktree-prune fix hangs on: **a worktree that
 * contains a running process is NEVER prunable.** On 2026-07-18 o8's own
 * pruner `rm -rf`'d the worktrees of four LIVE Codex workers mid-turn — every
 * rollout recorded `turn_aborted / reason: "interrupted"` in the same second
 * because their cwd was deleted out from under them. Nothing checked whether a
 * process was still living in the directory before the destructive step.
 *
 * `hasLiveProcessInside(dir)` answers "does any live process have its cwd under
 * `dir`?" via an ANDed `lsof -d cwd +D` query. Descriptor selection matters:
 * the Next backend watches files in every worktree, so an any-open-fd scan
 * makes every tree look live while o8 is running. A real worker is spawned with
 * cwd=<worktree>, which this detects even when the path is absent from argv.
 *
 * Fail CLOSED: any probe error — timeout, missing `lsof`, permission, a
 * nonsense path — is treated as "live" so the caller KEEPS the worktree. We
 * would rather leak a stale directory than abort a live worker's turn.
 */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Probe budget. Past this we fail closed (treat the tree as live → keep). */
const PROBE_TIMEOUT_MS = 5_000;

export type LiveProcessProbeResult =
  | { status: 'clear' }
  | { status: 'live'; pids: string[] }
  | { status: 'inconclusive'; reason: string };

interface LiveProcessCommandResult {
  stdout: string | Buffer;
  stderr?: string | Buffer;
}

export interface LiveProcessProbeOptions {
  /** Test seam for deterministic lsof exit/error shapes. */
  runLsof?: (target: string, args: string[]) => Promise<LiveProcessCommandResult>;
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

function compactDetail(value: unknown): string {
  return outputText(value).trim().replace(/\s+/g, ' ').slice(0, 500);
}

function liveResult(stdout: unknown): LiveProcessProbeResult | null {
  const pids = outputText(stdout).split(/\s+/).map((pid) => pid.trim()).filter(Boolean);
  return pids.length > 0 ? { status: 'live', pids } : null;
}

/**
 * True when any live process has an open file (or cwd) inside `dirPath`.
 *
 * Fail-closed contract: returns `true` on ANY uncertainty (probe error,
 * timeout, missing binary, nonsense path) so the worktree is preserved.
 * Returns `false` only when `lsof` cleanly reports nothing open under the tree.
 */
export async function probeLiveProcessInside(
  dirPath: string,
  options: LiveProcessProbeOptions = {},
): Promise<LiveProcessProbeResult> {
  const target = path.resolve(dirPath);
  // A blank or root path would make `lsof +D` scan the whole filesystem —
  // refuse and fail closed.
  if (!target || target === '/' || target === path.parse(target).root) {
    return { status: 'inconclusive', reason: `unsafe probe target ${JSON.stringify(target)}` };
  }

  try {
    // `-a` ANDs the cwd-descriptor and recursive-directory selectors. This
    // excludes backend watcher FDs while retaining a worker cwd'd anywhere in
    // the tree. Exit 1 with empty stdout+stderr is the only clear signal.
    const args = ['-a', '-d', 'cwd', '+D', target, '-t'];
    const { stdout } = options.runLsof
      ? await options.runLsof(target, args)
      : await execFileAsync('lsof', args, { windowsHide: true, timeout: PROBE_TIMEOUT_MS });
    return liveResult(stdout)
      ?? { status: 'inconclusive', reason: 'lsof exited 0 without reporting a PID' };
  } catch (err) {
    const e = err as {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    // Timeout (killed by signal) → we could not finish the probe → fail closed.
    if (e?.killed === true || e?.signal) {
      return { status: 'inconclusive', reason: `lsof timed out after ${PROBE_TIMEOUT_MS / 1000}s` };
    }

    // lsof exit 1 == "nothing found under the dir" (the clean not-live path).
    // But lsof also exits 1 in some partial-scan cases while still having
    // printed live PIDs — if stdout carried any PID, treat as live.
    if (e?.code === 1 || e?.code === '1') {
      const live = liveResult(e.stdout);
      if (live) return live;
      const stderr = compactDetail(e.stderr);
      return stderr
        ? { status: 'inconclusive', reason: `lsof partial/failed scan: ${stderr}` }
        : { status: 'clear' };
    }

    // Any other failure — lsof missing (ENOENT), permission, exit 2+ — is
    // genuine uncertainty. Fail closed.
    const detail = compactDetail(e?.stderr) || compactDetail(e?.message) || 'unknown error';
    return { status: 'inconclusive', reason: `lsof failed${e?.code ? ` (${String(e.code)})` : ''}: ${detail}` };
  }
}

export async function hasLiveProcessInside(
  dirPath: string,
  options: LiveProcessProbeOptions = {},
): Promise<boolean> {
  return (await probeLiveProcessInside(dirPath, options)).status !== 'clear';
}

/**
 * Final deletion-seam guard. Returns true only after a clean lsof result, or
 * when a caller explicitly certifies that it already confirmed the session's
 * process exited. Live and inconclusive probes are both refused loudly.
 */
export async function allowWorktreeRemoval(
  dirPath: string,
  options: { logPrefix: string; overrideLiveGuard?: true },
): Promise<boolean> {
  if (options.overrideLiveGuard === true) {
    console.warn(`[${options.logPrefix}] LIVE-PROCESS GUARD OVERRIDDEN for ${dirPath} — caller confirmed the session process exited`);
    return true;
  }

  const probe = await probeLiveProcessInside(dirPath);
  if (probe.status === 'clear') return true;
  if (probe.status === 'live') {
    console.error(`[${options.logPrefix}] REFUSED worktree removal for ${dirPath} — live process found (pid ${probe.pids.join(', ')})`);
  } else {
    console.error(`[${options.logPrefix}] REFUSED worktree removal for ${dirPath} — live-process probe inconclusive: ${probe.reason}`);
  }
  return false;
}
