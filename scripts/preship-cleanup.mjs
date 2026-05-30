#!/usr/bin/env node
/**
 * preship-cleanup — pre-build guard against the orphaned-build lock cascade.
 *
 * A failed `next build` can leave an orphaned process still holding
 * `.next/lock`. The next ship then fails one of two ways:
 *   1. "Unable to acquire lock at .next/lock, is another instance running?"
 *      → tauri:prebuild aborts (and `rm -rf .next` fails: "Directory not empty"
 *      because the live orphan keeps recreating files).
 *   2. If the retry's build starts anyway, two ~6.5 GB `next build` processes
 *      run at once and the OS SIGKILLs one (exit 137) under the combined load.
 *
 * Both modes bit the 0.1.208 ship (3 failed attempts) until the orphan was
 * killed by hand. This guard kills any stale `next build` and clears a stale
 * lock so every native build starts from a clean slate — regardless of how much
 * other RAM is in use. Best-effort + non-fatal: if pgrep is missing (CI) or a
 * kill fails, we log and continue.
 */
import { execSync } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';

function staleNextBuildPids() {
  try {
    return execSync("pgrep -f 'next build' || true", { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .split('\n')
      .map((s) => Number(s.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  } catch {
    return []; // pgrep unavailable (non-unix CI) — nothing to clean
  }
}

let killed = 0;
for (const pid of staleNextBuildPids()) {
  try {
    process.kill(pid, 'SIGKILL');
    killed += 1;
    console.log(`[preship-cleanup] killed stale next build pid ${pid}`);
  } catch {
    // already gone or not ours — ignore
  }
}

if (existsSync('.next/lock')) {
  try {
    rmSync('.next/lock', { force: true });
    console.log('[preship-cleanup] removed stale .next/lock');
  } catch {
    // locked by something we couldn't kill — let next build report it
  }
}

if (!killed) console.log('[preship-cleanup] clean — no stale next build');
