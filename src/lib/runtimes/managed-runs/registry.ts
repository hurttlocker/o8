/**
 * Registry for `o8 run` managed sessions.
 *
 * In-process (globalThis singleton — survives Next route-module re-instantiation)
 * and disk-backed at `<dataDir>/managed-runs.json` (atomic, merge-on-write) so it
 * survives a Next *process* restart (every auto-update) and tolerates a second
 * Next process (dev-bridge) without dropping the other process's runs. The tmux
 * server outlives Next, so a hydrated record's `panePid` stays usable for port
 * attribution until the next reconcile against `tmux ls` flips dead sessions away.
 *
 * One primary process serves the UI; the ws-server does not read this.
 */

import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { listCortexTmuxSessions } from '@/lib/terminal/tmux';
import { getDataDir } from '@/lib/data-dir-migration';
import type {
  ManagedRunRecord,
  ManagedRunStatus,
  ManagedRunTerminationReceipt,
} from './types';

/** keep at most this many records (running always kept; oldest terminal dropped) */
const RETENTION = 50;
const VALID_STATUS: ReadonlySet<string> = new Set<ManagedRunStatus>(['running', 'finished', 'gone', 'killed']);

const store = globalThis as typeof globalThis & {
  __o8ManagedRuns?: Map<string, ManagedRunRecord>;
  __o8ManagedRunsHydrated?: boolean;
};
const runs = store.__o8ManagedRuns ?? new Map<string, ManagedRunRecord>();
store.__o8ManagedRuns = runs;

// newest-first; tolerant of a missing startedAt so one malformed record can
// never throw inside the comparator and poison the whole list.
function byStartedDesc(a: ManagedRunRecord, b: ManagedRunRecord): number {
  return (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
}

/** Structural guard for persisted records — drop anything that would break sorts/reads. */
function isValidRecord(rec: unknown): rec is ManagedRunRecord {
  if (!rec || typeof rec !== 'object') return false;
  const r = rec as Record<string, unknown>;
  return typeof r.id === 'string' && r.id.length > 0
    && typeof r.session === 'string' && r.session.startsWith('cortex-run-')
    && typeof r.command === 'string'
    && typeof r.cwd === 'string'
    && typeof r.startedAt === 'string' && r.startedAt.length > 0
    && typeof r.status === 'string' && VALID_STATUS.has(r.status);
}

// ── Persistence ──

function runsFile(): string {
  return join(getDataDir(), 'managed-runs.json');
}

/** Cap the persisted set: always keep running runs, then the newest terminals. */
function capForPersist(list: ManagedRunRecord[]): ManagedRunRecord[] {
  if (list.length <= RETENTION) return list;
  const running = list.filter((r) => r.status === 'running');
  const terminal = list.filter((r) => r.status !== 'running').sort(byStartedDesc);
  return [...running, ...terminal.slice(0, Math.max(0, RETENTION - running.length))];
}

/**
 * Atomic, merge-on-write best-effort persist. Unions our in-memory view with
 * whatever is on disk (a second process — e.g. dev-bridge — may hold runs this
 * process never saw), in-memory winning per session, so no process clobbers
 * another's runs. Never blocks the registry.
 */
function persist(): void {
  try {
    const file = runsFile();
    mkdirSync(getDataDir(), { recursive: true });
    const merged = new Map<string, ManagedRunRecord>();
    try {
      if (existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { runs?: unknown[] };
        for (const rec of parsed.runs ?? []) {
          if (isValidRecord(rec)) merged.set(rec.session, rec);
        }
      }
    } catch { /* corrupt on-disk snapshot — our view replaces it */ }
    for (const [session, rec] of runs) merged.set(session, rec);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ runs: capForPersist([...merged.values()]) }), 'utf8');
    renameSync(tmp, file);
  } catch { /* disk unavailable — keep running in-memory */ }
}

/**
 * Recover a run's exit code from the pane wrapper's durable exit receipt.
 * Signal receipts map to their conventional shell exit codes. Returns null
 * while a live run has not written its receipt or for an unknown signal.
 */
function readExitCode(id: string): number | null {
  try {
    const path = join(getDataDir(), 'logs', 'run', `${id}.exit`);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8').trim();
    if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
    const signal = raw.match(/^signal:(HUP|INT|QUIT|KILL|TERM)$/)?.[1];
    if (!signal) return null;
    const number = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, TERM: 15 }[signal];
    return number === undefined ? null : 128 + number;
  } catch {
    return null;
  }
}

function retainUnknownExitReceipt(id: string): void {
  try {
    const directory = join(getDataDir(), 'logs', 'run');
    const path = join(directory, `${id}.exit`);
    if (existsSync(path)) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(path, 'signal:UNKNOWN', { flag: 'wx', mode: 0o600 });
  } catch { /* best effort after an untrappable wrapper exit */ }
}

/** Load persisted records on first module init (per process), validating each. */
function hydrate(): void {
  if (store.__o8ManagedRunsHydrated) return;
  store.__o8ManagedRunsHydrated = true;
  try {
    const file = runsFile();
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { runs?: unknown[] };
    for (const rec of parsed.runs ?? []) {
      if (isValidRecord(rec) && !runs.has(rec.session)) runs.set(rec.session, rec);
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

export function findManagedRun(idOrSession: string): ManagedRunRecord | null {
  return runs.get(idOrSession) ?? [...runs.values()].find((run) => run.id === idOrSession) ?? null;
}

/**
 * Mark a run finished. Idempotent + monotonic: a terminal record is never
 * re-stamped or downgraded; a real exit code may only UPGRADE a record whose
 * code is still unknown (e.g. reconcile recorded `gone`, then the stream CLI's
 * finish POST lands with the real code). A null code never clobbers a known one.
 */
export function finishManagedRun(
  idOrSession: string,
  exitCode: number | null,
): ManagedRunRecord | null {
  const rec = runs.get(idOrSession) ?? [...runs.values()].find((r) => r.id === idOrSession) ?? null;
  if (!rec) return null;
  if (rec.status !== 'running') {
    if (exitCode !== null && rec.exitCode === null) {
      rec.exitCode = exitCode;
      rec.status = 'finished';
      persist();
    }
    return rec;
  }
  rec.status = 'finished';
  rec.exitCode = exitCode;
  rec.finishedAt = new Date().toISOString();
  persist();
  return rec;
}

/** Mark a run killed by the operator (only a still-running record transitions). */
export function killManagedRun(
  session: string,
  exitCode: number | null,
  termination: ManagedRunTerminationReceipt,
): ManagedRunRecord | null {
  const rec = runs.get(session) ?? null;
  if (!rec) return null;
  if (!termination.confirmedDead) return rec;
  if (rec.status === 'running' || rec.status === 'gone') {
    rec.status = 'killed';
    rec.finishedAt = new Date().toISOString();
    rec.exitCode = exitCode;
    rec.termination = termination;
    persist();
  }
  return rec;
}

/**
 * Reconcile every record against live tmux sessions (one `tmux ls`), settle
 * vanished sessions, prune, persist if anything changed, and return newest-first.
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
  const reconciled: ManagedRunRecord[] = [];
  for (const rec of runs.values()) {
    if (rec.status === 'running' && !alive.has(rec.session)) {
      // Only detached runs need exit-file recovery here — streaming runs POST
      // their own finish, and reading the file under them would race the CLI's
      // own read+delete. A detach run's exit-file (when present) gives the real
      // code → finished; absent (killed mid-command / app was down) → gone.
      const code = rec.mode === 'detach' ? readExitCode(rec.id) : null;
      if (rec.mode === 'detach' && code === null) retainUnknownExitReceipt(rec.id);
      rec.status = code === null ? 'gone' : 'finished';
      rec.exitCode = code;
      rec.finishedAt = rec.finishedAt ?? now;
      changed = true;
      reconciled.push(rec);
    }
  }
  if (prune()) changed = true;
  if (changed) persist();
  if (reconciled.length > 0) {
    try {
      const { recordAutomationSourceEvent } = await import('@/lib/automations/source-events');
      for (const rec of reconciled) {
        const eventType = rec.status === 'gone'
          ? 'lost'
          : rec.exitCode === 0 ? 'exit_clean' : 'exit_failed';
        recordAutomationSourceEvent({
          sourceKind: 'managed_run',
          sourceId: rec.id,
          repoPath: rec.cwd,
          eventType,
          fingerprint: rec.status === 'gone'
            ? `managed-run:${rec.id}:lost:${rec.finishedAt ?? 'unknown'}`
            : `managed-run:${rec.id}:finished:${rec.exitCode ?? 'unknown'}`,
          occurredAt: Date.parse(rec.finishedAt ?? now) || Date.now(),
          payload: { exitCode: rec.exitCode ?? null, status: rec.status, mode: rec.mode },
        });
      }
    } catch {
      // Run reconciliation stays available if automation storage is unavailable.
    }
  }
  return [...runs.values()].sort(byStartedDesc);
}

/** All still-running runs, newest-first (used by the ports route for pane-pid attribution). */
export function listRunningRuns(): ManagedRunRecord[] {
  return [...runs.values()].filter((r) => r.status === 'running').sort(byStartedDesc);
}

/** Drop oldest terminal records beyond RETENTION. Returns true if anything was removed. */
function prune(): boolean {
  if (runs.size <= RETENTION) return false;
  const terminal = [...runs.values()].filter((r) => r.status !== 'running');
  terminal.sort((a, b) => (a.finishedAt ?? a.startedAt ?? '').localeCompare(b.finishedAt ?? b.startedAt ?? ''));
  let excess = runs.size - RETENTION;
  let removed = false;
  for (const rec of terminal) {
    if (excess <= 0) break;
    runs.delete(rec.session);
    excess -= 1;
    removed = true;
  }
  return removed;
}
