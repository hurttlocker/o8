/**
 * Append-only Symon ledger writes for standing watches.
 *
 * Symon's own ledger is the native Rust one in `<data-dir>/agent.db`. A watch
 * outlives the turn that registered it, so the events that matter most (it
 * fired, it parked, it drained, it expired) happen in this Node process long
 * after the native turn ended. Both sides resolve the same data directory and
 * both create the table with `CREATE TABLE IF NOT EXISTS`, so this writer adds
 * rows to the same durable ledger rather than a parallel one. It only ever
 * INSERTs — the table carries append-only triggers on both sides.
 */
import Database from 'better-sqlite3';
import { join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';

export type SymonWatchLedgerPhase =
  | 'watch_registered'
  | 'watch_fired'
  | 'watch_parked'
  | 'watch_drained'
  | 'watch_ran'
  | 'watch_cancelled'
  | 'watch_expired';

export interface SymonWatchLedgerEvent {
  watchId: string;
  phase: SymonWatchLedgerPhase;
  /** Caller-authored and trusted. Never pass raw source-event payload text. */
  redactedSummary: string;
  outcome: string;
  sessionId?: string | null;
  nowMs?: number;
}

/** Mirrors `src-tauri/src/agent/store.rs` exactly; whoever boots first wins. */
const PLAN_EVENT_DDL = `
  CREATE TABLE IF NOT EXISTS agent_plan_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    phase TEXT NOT NULL,
    redacted_summary TEXT NOT NULL,
    outcome TEXT NOT NULL,
    session_id TEXT,
    step_index INTEGER,
    step_count INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agent_plan_events_plan_id
    ON agent_plan_events (plan_id, seq);
  CREATE INDEX IF NOT EXISTS idx_agent_plan_events_task_id
    ON agent_plan_events (task_id, seq);
  CREATE TRIGGER IF NOT EXISTS agent_plan_events_no_update
    BEFORE UPDATE ON agent_plan_events
    BEGIN SELECT RAISE(ABORT, 'agent plan events are append-only'); END;
  CREATE TRIGGER IF NOT EXISTS agent_plan_events_no_delete
    BEFORE DELETE ON agent_plan_events
    BEGIN SELECT RAISE(ABORT, 'agent plan events are append-only'); END;
`;

let cached: { path: string; db: Database.Database } | null = null;

function ledgerDb(): Database.Database | null {
  const path = join(getDataDir(), 'agent.db');
  if (cached && cached.path === path && cached.db.open) return cached.db;
  try {
    const db = new Database(path);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 2000');
    db.exec(PLAN_EVENT_DDL);
    cached = { path, db };
    return db;
  } catch (error) {
    console.warn('[symon-watch] ledger unavailable:', error instanceof Error ? error.message : error);
    return null;
  }
}

/** Close the cached handle so a test (or a data-dir move) reopens cleanly. */
export function closeSymonWatchLedger(): void {
  try {
    cached?.db.close();
  } catch {
    // A already-closed handle is fine; the next write reopens.
  }
  cached = null;
}

/**
 * Append one watch lifecycle checkpoint. Returns false when the ledger cannot
 * be reached: a watch must still fire when Symon's ledger file is missing, and
 * the durable automation row remains the authoritative record either way.
 */
export function recordSymonWatchLedgerEvent(event: SymonWatchLedgerEvent): boolean {
  const db = ledgerDb();
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO agent_plan_events (
        plan_id, task_id, source, created_at, phase,
        redacted_summary, outcome, session_id, step_index, step_count
      ) VALUES (?, ?, 'symon_watch', ?, ?, ?, ?, ?, NULL, 1)
    `).run(
      event.watchId,
      event.watchId,
      Math.floor((event.nowMs ?? Date.now()) / 1_000),
      event.phase,
      event.redactedSummary.slice(0, 600),
      event.outcome,
      event.sessionId ?? null,
    );
    return true;
  } catch (error) {
    console.warn('[symon-watch] ledger write failed:', error instanceof Error ? error.message : error);
    cached = null;
    return false;
  }
}

/** Read this watch's ledger trail, newest first. Used by `symon_watch_list`. */
export function readSymonWatchLedger(watchId: string, limit: number = 10): Array<{
  phase: string;
  outcome: string;
  summary: string;
  createdAt: number;
}> {
  const db = ledgerDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT phase, outcome, redacted_summary AS summary, created_at AS createdAt
      FROM agent_plan_events
      WHERE plan_id = ? AND source = 'symon_watch'
      ORDER BY seq DESC LIMIT ?
    `).all(watchId, Math.min(50, Math.max(1, Math.floor(limit)))) as Array<{
      phase: string;
      outcome: string;
      summary: string;
      createdAt: number;
    }>;
  } catch {
    return [];
  }
}
