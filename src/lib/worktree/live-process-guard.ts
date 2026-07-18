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
 * `hasLiveProcessInside(dir)` answers "does any live process have an open file
 * (including its cwd) under `dir`?" via `lsof +D`, which detects a process
 * whose *cwd* is inside the tree even when the path never appears in its argv
 * (a `codex exec` worker spawned with cwd=<worktree> is exactly this case, so
 * a `pgrep -f <path>` argv match would miss it).
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
const PROBE_TIMEOUT_MS = 2_000;

/**
 * True when any live process has an open file (or cwd) inside `dirPath`.
 *
 * Fail-closed contract: returns `true` on ANY uncertainty (probe error,
 * timeout, missing binary, nonsense path) so the worktree is preserved.
 * Returns `false` only when `lsof` cleanly reports nothing open under the tree.
 */
export async function hasLiveProcessInside(dirPath: string): Promise<boolean> {
  const target = path.resolve(dirPath);
  // A blank or root path would make `lsof +D` scan the whole filesystem —
  // refuse and fail closed.
  if (!target || target === '/' || target === path.parse(target).root) {
    return true;
  }

  try {
    // `lsof +D <dir> -t` lists PIDs of processes with any open file (incl. cwd)
    // under <dir>. Exit 0 + PIDs → live. When nothing is open lsof exits 1 with
    // empty output (that is the ONLY "not live" signal we trust).
    const { stdout } = await execFileAsync('lsof', ['+D', target, '-t'], {
      timeout: PROBE_TIMEOUT_MS,
    });
    return stdout.trim().length > 0;
  } catch (err) {
    const e = err as {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string | Buffer;
    };
    // Timeout (killed by signal) → we could not finish the probe → fail closed.
    if (e?.killed === true || e?.signal) return true;

    // lsof exit 1 == "nothing found under the dir" (the clean not-live path).
    // But lsof also exits 1 in some partial-scan cases while still having
    // printed live PIDs — if stdout carried any PID, treat as live.
    if (e?.code === 1 || e?.code === '1') {
      const out = typeof e.stdout === 'string'
        ? e.stdout
        : Buffer.isBuffer(e.stdout)
          ? e.stdout.toString('utf8')
          : '';
      return out.trim().length > 0;
    }

    // Any other failure — lsof missing (ENOENT), permission, exit 2+ — is
    // genuine uncertainty. Fail closed.
    return true;
  }
}
