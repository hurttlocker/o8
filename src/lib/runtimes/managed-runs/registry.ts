/**
 * Registry for `o8 run` managed sessions.
 *
 * In-process (globalThis singleton — same pattern as the GitHub device-flow
 * store) so it survives Next route-module re-instantiation, and disk-backed at
 * `<dataDir>/managed-runs.json` so it survives a Next *process* restart (every
 * auto-update). The tmux server outlives the Next process, so a hydrated
 * record's `panePid` stays valid for port attribution; a session that died
 * while the app was down is reconciled to `gone` on the next list.
 *
 * Single Next process only — the ws-server does not read this; it attaches tmux
 * sessions by name, registry-free.
 */

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { listCortexTmuxSessions } from '@/lib/terminal/tmux';
import { getDataDir } from '@/lib/data-dir-migration';
import type { ManagedRunRecord } from './types';

/** keep at most this many records (running always kept; oldest finished dropped) */
const RETENTION = 50;

const store = globalThis as typeof globalThis & {
  __o8ManagedRuns?: Map<string, ManagedRunRecord>;
  __o8ManagedRunsHydrated?: boolean;
};
const runs = store.__o8ManagedRuns ?? new Map<string, ManagedRunRecord>();
store.__o8ManagedRuns = runs;

// ── Persistence ──

function runsFile(): string {
  return join(getDataDir(), 'managed-runs.json');
}

/** Atomic best-effort write — persistence is a nicety, never block the registry. */
function persist(): void {
  try {
    const file = runsFile();
    mkdirSync(getDataDir(), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ runs: [...runs.values()] }), 'utf8');
    renameSync(tmp, file);
  } catch { /* disk unavailable — keep running in-memory */ }
}

/** Load persisted records on first module init (per process). */
function hydrate(): void {
  if (store.__o8ManagedRunsHydrated) return;
  store.__o8ManagedRunsHydrated = true;
  try {
    const file = runsFile();
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { runs?: ManagedRunRecord[] };
    for (const rec of parsed.runs ?? []) {
      if (rec && typeof rec.session === 'string' && !runs.has(rec.session)) {
        runs.set(rec.session, rec);
      }
    }
  } catch { /* missing/corrupt — start empty */ }
}
hydrate();

// ── Mutations ──

export function registerManagedRun(rec: ManagedRunRecord): ManagedRunRecord {
  runs.set(rec.session, rec);
  prune();
  persist();
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
  persist();
  return rec;
}

/**
 * Reconcile every record against live tmux sessions (one `tmux ls`), flip
 * vanished sessions to `gone`, prune, persist if anything changed, and return
 * newest-first.
 */
export async function listManagedRuns(): Promise<ManagedRunRecord[]> {
  let alive: Set<string>;
  try {
    alive = new Set((await listCortexTmuxSessions()).filter((n) => n.startsWith('cortex-run-')));
  } catch {
    alive = new Set<string>();
  }
  const now = new Date().toISOString();
  let changed = false;
  for (const rec of runs.values()) {
    if (rec.status === 'running' && !alive.has(rec.session)) {
      // Session vanished (operator closed it, the process died before the
      // streaming CLI could mark it finished, or it ended while the app was down).
      rec.status = 'gone';
      rec.finishedAt = rec.finishedAt ?? now;
      changed = true;
    }
  }
  if (prune()) changed = true;
  if (changed) persist();
  return [...runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** All still-running runs, newest-first (used by the ports route for pane-pid attribution). */
export function listRunningRuns(): ManagedRunRecord[] {
  return [...runs.values()]
    .filter((r) => r.status === 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Drop oldest finished records beyond RETENTION. Returns true if anything was removed. */
function prune(): boolean {
  if (runs.size <= RETENTION) return false;
  const finished = [...runs.values()].filter((r) => r.status !== 'running');
  finished.sort((a, b) =>
    (a.finishedAt ?? a.startedAt).localeCompare(b.finishedAt ?? b.startedAt),
  );
  let excess = runs.size - RETENTION;
  let removed = false;
  for (const rec of finished) {
    if (excess <= 0) break;
    runs.delete(rec.session);
    excess -= 1;
    removed = true;
  }
  return removed;
}
