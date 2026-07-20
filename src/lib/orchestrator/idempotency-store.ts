/**
 * Persisted idempotency store (#1497).
 *
 * The predecessor `idempotency-cache.ts` was in-memory only and wired ONLY to
 * merge_preview / approve_and_merge. Two holes bit us live (2026-07-08):
 *   1. steer / rerun / dispatch had NO guard, so a client timeout+retry
 *      double-fired — a rerun landed twice and forked two parallel clones.
 *   2. A restart wiped the in-memory map, so any in-flight guard vanished.
 *
 * This store is SQLite-backed (`idempotency_keys`, schema v32) so the guard
 * survives a restart, and it uses a reserve → finalize protocol so a duplicate
 * that arrives WHILE the first call is still running (the real incident — a
 * dispatch takes minutes, the client times out at 15s) is told "already in
 * progress, not re-executed" instead of forking a second worker:
 *
 *   1. RESERVE — `INSERT OR IGNORE` a row (result_json NULL) keyed by the
 *      derived key. Winning the insert means we own the execution.
 *   2. RUN — execute the wrapped operation.
 *   3. FINALIZE — write the JSON result onto the reserved row.
 *
 * A caller that loses the reserve (row already present) replays the finalized
 * result, or — if the owner is still running (result_json NULL) — returns an
 * `inProgress` marker WITHOUT re-executing. On a thrown run() the reservation
 * is deleted so a legitimate retry of a genuinely-failed op can proceed
 * (idempotency replays SUCCESSES, never caches failures).
 *
 * Merge verbs (approve_and_merge) now share this store too (#1513). The old
 * in-memory `idempotency-cache.ts` — deleted — intentionally forgot in-flight
 * merges on restart so the operator could retry immediately; that property is
 * preserved by stamping the owning `pid` on each reservation and reaping
 * reservations from dead processes on DB init (see `reapDeadIdempotencyReservations`
 * in `db/index.ts`). A LIVE in-flight merge is still deduped; a restart-orphaned
 * one becomes immediately retryable.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDb, getSqlite } from '@/lib/db';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface IdempotencyOutcome<T> {
  /** true when this call did NOT execute run() — replayed or in-flight duplicate. */
  replayed: boolean;
  /** true when a duplicate arrived while the original was still running. */
  inProgress: boolean;
  result: T;
}

/** Marker returned to a duplicate that raced an in-flight original. */
export interface InProgressMarker {
  deduped: true;
  status: 'in_progress';
  verb: string;
  note: string;
}

function normalizeBody(body: string | undefined): string {
  return (body ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Derive the idempotency key. An explicit client key (when a caller supplies
 * one) wins; otherwise hash(verb + scopeId + normalized body) so a timeout+retry
 * of the SAME logical call collides within the TTL window.
 */
export function deriveIdempotencyKey(input: {
  verb: string;
  scopeId: string;
  clientKey?: string | null;
  body?: string;
}): string {
  const clientKey = input.clientKey?.trim();
  if (clientKey) return `${input.verb}:${input.scopeId}:ck:${clientKey}`;
  const digest = createHash('sha256')
    .update(`${input.verb}\u0000${input.scopeId}\u0000${normalizeBody(input.body)}`)
    .digest('hex')
    .slice(0, 32);
  return `${input.verb}:${input.scopeId}:h:${digest}`;
}

interface KeyRow {
  result_json: string | null;
  expires_at: number;
}

function pruneExpired(now: number): void {
  try {
    getSqlite().prepare('DELETE FROM idempotency_keys WHERE expires_at <= ?').run(now);
  } catch (error) {
    console.warn('[idempotency] prune failed:', error instanceof Error ? error.message : error);
  }
}

function selectFresh(key: string, now: number): KeyRow | undefined {
  const row = getSqlite()
    .prepare('SELECT result_json, expires_at FROM idempotency_keys WHERE key = ?')
    .get(key) as KeyRow | undefined;
  if (!row) return undefined;
  if (row.expires_at <= now) return undefined;
  return row;
}

/** RESERVE: returns true iff this call won the insert (owns the execution). */
function reserve(
  key: string,
  verb: string,
  packetId: string,
  reservationId: string,
  now: number,
  expiresAt: number,
): boolean {
  const info = getSqlite()
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys (key, verb, packet_id, result_json, pid, reservation_id, created_at, expires_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?)`,
    )
    .run(key, verb, packetId, process.pid, reservationId, now, expiresAt);
  return info.changes > 0;
}

function finalize(key: string, reservationId: string, resultJson: string, expiresAt: number): void {
  // Clear pid on finalize — a finalized row is a replay cache with no live
  // owner, so it must never look like a reapable in-flight reservation.
  getSqlite()
    .prepare('UPDATE idempotency_keys SET result_json = ?, pid = NULL, expires_at = ? WHERE key = ? AND reservation_id = ? AND result_json IS NULL')
    .run(resultJson, expiresAt, key, reservationId);
}

function release(key: string, reservationId: string): void {
  try {
    getSqlite().prepare('DELETE FROM idempotency_keys WHERE key = ? AND reservation_id = ? AND result_json IS NULL')
      .run(key, reservationId);
  } catch (error) {
    console.warn('[idempotency] release failed:', error instanceof Error ? error.message : error);
  }
}

/** Clear live reservations when a packet operation is terminated externally. */
export function releaseInProgressIdempotencyForScope(scopeId: string): number {
  try {
    const result = getSqlite()
      .prepare('DELETE FROM idempotency_keys WHERE packet_id = ? AND result_json IS NULL')
      .run(scopeId);
    if (result.changes > 0) {
      console.warn(`[idempotency] Released ${result.changes} terminated in-progress operation(s) for ${scopeId}.`);
    }
    return result.changes;
  } catch (error) {
    console.warn('[idempotency] scope release failed:', error instanceof Error ? error.message : error);
    return 0;
  }
}

function inProgressMarker<T>(verb: string): T {
  return {
    deduped: true,
    status: 'in_progress',
    verb,
    note: `An identical ${verb} is already in progress; not re-executed.`,
  } as InProgressMarker as unknown as T;
}

/**
 * Run `run()` at most once per key within the TTL window, across restarts.
 *
 * - First caller: reserves, executes, finalizes → { replayed:false }.
 * - Later caller, original finished: replays the stored result → { replayed:true }.
 * - Later caller, original in flight: { replayed:true, inProgress:true } with an
 *   InProgressMarker result — does NOT re-execute.
 *
 * Degrades to a plain `run()` (no dedup) when the DB is unavailable — the guard
 * must never break the route.
 */
export async function withIdempotency<T>(
  params: {
    key: string;
    verb: string;
    scopeId: string;
    ttlMs?: number;
    now?: number;
  },
  run: () => Promise<T>,
): Promise<IdempotencyOutcome<T>> {
  const { key, verb, scopeId } = params;
  if (!getDb()) {
    return { replayed: false, inProgress: false, result: await run() };
  }
  const now = params.now ?? Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = now + ttlMs;

  pruneExpired(now);

  const existing = selectFresh(key, now);
  if (existing) {
    if (existing.result_json !== null) {
      return { replayed: true, inProgress: false, result: JSON.parse(existing.result_json) as T };
    }
    return { replayed: true, inProgress: true, result: inProgressMarker<T>(verb) };
  }

  const reservationId = randomUUID();
  const won = reserve(key, verb, scopeId, reservationId, now, expiresAt);
  if (!won) {
    // Lost the reserve race between select and insert — re-read the winner's row.
    const raced = selectFresh(key, now);
    if (raced?.result_json != null) {
      return { replayed: true, inProgress: false, result: JSON.parse(raced.result_json) as T };
    }
    return { replayed: true, inProgress: true, result: inProgressMarker<T>(verb) };
  }

  try {
    const result = await run();
    finalize(key, reservationId, JSON.stringify(result ?? null), expiresAt);
    return { replayed: false, inProgress: false, result };
  } catch (error) {
    // Failures are retryable — drop the reservation so a real retry can run.
    release(key, reservationId);
    throw error;
  }
}

/** Test-only: wipe the table. */
export function __resetIdempotencyStoreForTests(): void {
  try {
    getSqlite().prepare('DELETE FROM idempotency_keys').run();
  } catch {
    // DB not initialized — nothing to reset.
  }
}
