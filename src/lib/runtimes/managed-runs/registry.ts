/**
 * In-process registry for `o8 run` managed sessions.
 *
 * Survives Next route-module re-instantiation via a globalThis singleton (same
 * pattern as the GitHub device-flow store). Single Next process only — the
 * ws-server does not read this; it attaches tmux sessions by name, registry-free.
 */

import { listCortexTmuxSessions } from '@/lib/terminal/tmux';
import type { ManagedRunRecord } from './types';

/** keep at most this many records (running always kept; oldest finished dropped) */
const RETENTION = 50;

const store = globalThis as typeof globalThis & {
  __o8ManagedRuns?: Map<string, ManagedRunRecord>;
};
const runs = store.__o8ManagedRuns ?? new Map<string, ManagedRunRecord>();
store.__o8ManagedRuns = runs;

export function registerManagedRun(rec: ManagedRunRecord): ManagedRunRecord {
  runs.set(rec.session, rec);
  prune();
  return rec;
}

export function finishManagedRun(
  idOrSession: string,
  exitCode: number | null,
): ManagedRunRecord | null {
  const rec = runs.get(idOrSession) ?? [...runs.values()].find((r) => r.id === idOrSession) ?? null;
  if (!rec) return null;
  rec.status = 'finished';
  rec.finishedAt = new Date().toISOString();
  rec.exitCode = exitCode;
  return rec;
}

/**
 * Reconcile every record against live tmux sessions (one `tmux ls`), flip
 * vanished sessions to `gone`, prune, and return newest-first.
 */
export async function listManagedRuns(): Promise<ManagedRunRecord[]> {
  let alive: Set<string>;
  try {
    alive = new Set((await listCortexTmuxSessions()).filter((n) => n.startsWith('cortex-run-')));
  } catch {
    alive = new Set<string>();
  }
  const now = new Date().toISOString();
  for (const rec of runs.values()) {
    if (rec.status === 'running' && !alive.has(rec.session)) {
      // Session vanished (operator closed it, or the process died before the
      // streaming CLI could mark it finished).
      rec.status = 'gone';
      rec.finishedAt = rec.finishedAt ?? now;
    }
  }
  prune();
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** All still-running runs, newest-first (used by the ports route for pane-pid attribution). */
export function listRunningRuns(): ManagedRunRecord[] {
  return [...runs.values()]
    .filter((r) => r.status === 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function prune() {
  if (runs.size <= RETENTION) return;
  const finished = [...runs.values()].filter((r) => r.status !== 'running');
  finished.sort((a, b) =>
    (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt),
  );
  let excess = runs.size - RETENTION;
  for (const rec of finished) {
    if (excess <= 0) break;
    runs.delete(rec.session);
    excess -= 1;
  }
}
