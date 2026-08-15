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
 * result, or — if no terminal receipt exists yet (result_json NULL) — returns
 * an `inProgress` marker WITHOUT re-executing. On a thrown run() in the owning
 * process the reservation is deleted so a confirmed failure can be retried.
 *
 * Merge verbs (approve_and_merge) now share this store too (#1513). The old
 * in-memory `idempotency-cache.ts` — deleted — intentionally forgot in-flight
 * merges on restart so the operator could retry immediately; that property is
 * preserved by stamping the owning `pid` on each reservation and reaping
 * reservations from dead processes on DB init (see `reapDeadIdempotencyReservations`
 * in `db/index.ts`). A LIVE in-flight merge is still deduped; a restart-orphaned
 * one remains quarantined with an outcome-unknown receipt until a verb-specific
 * reconciler can prove whether the side effect happened.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getDb, getSqlite } from '@/lib/db';
import {
  isMetadataLockProcessIdentity,
  probeMetadataLockProcessIdentity,
  sameMetadataLockProcessIdentity,
  type MetadataLockProcessIdentity,
} from '@/lib/worktree/metadata-lock-process-identity';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

export interface IdempotencyOutcome<T> {
  /** true when this call did NOT execute run() — replayed or in-flight duplicate. */
  replayed: boolean;
  /** true when a duplicate arrived while the original was still running. */
  inProgress: boolean;
  /** The side effect completed, but its replay receipt only exists in-process. */
  persistenceDegraded?: boolean;
  /** The original process ended before a terminal receipt was persisted. */
  unresolved?: boolean;
  result: T;
}

/** Marker returned to a duplicate that raced an in-flight original. */
export interface InProgressMarker {
  deduped: true;
  status: 'in_progress';
  verb: string;
  note: string;
  outcomeUnknown?: boolean;
}

export type ClientMutationBindingResult =
  | { status: 'bound' | 'matched'; digest: string }
  | { status: 'conflict'; digest: string; existingDigest: string | null }
  | { status: 'unavailable'; digest: string };

function normalizeBody(body: string | undefined): string {
  return (body ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Persistently bind one caller-supplied mutation id to one canonical body.
 *
 * The ordinary idempotency key deliberately lets an explicit client key win,
 * so it cannot detect a client accidentally reusing that key with new input.
 * This completed-row binding uses the existing SQLite table and one atomic
 * INSERT OR IGNORE, making the comparison race-safe and restart-safe without a
 * schema migration. Callers still use withIdempotency for execution/replay.
 */
export function bindIdempotencyClientMutation(input: {
  namespace: string;
  clientKey: string;
  body: string;
  ttlMs?: number;
  now?: number;
}): ClientMutationBindingResult {
  const digest = createHash('sha256').update(input.body).digest('hex');
  if (!getDb()) return { status: 'unavailable', digest };

  const now = input.now ?? Date.now();
  const expiresAt = now + (input.ttlMs ?? DEFAULT_TTL_MS);
  pruneExpired(now);
  const clientKeyDigest = createHash('sha256').update(input.clientKey.trim()).digest('hex');
  const key = `${input.namespace}:client-mutation:${clientKeyDigest}`;
  const resultJson = JSON.stringify({ digest });
  const inserted = getSqlite().prepare(
    `INSERT OR IGNORE INTO idempotency_keys
      (key, verb, packet_id, result_json, pid, reservation_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`,
  ).run(key, `${input.namespace}.client_mutation`, input.namespace, resultJson, now, expiresAt);
  if (inserted.changes > 0) return { status: 'bound', digest };

  const existing = selectFresh(key, now);
  if (!existing?.result_json) return { status: 'conflict', digest, existingDigest: null };
  try {
    const parsed = JSON.parse(existing.result_json) as { digest?: unknown };
    const existingDigest = typeof parsed.digest === 'string' ? parsed.digest : null;
    return existingDigest === digest
      ? { status: 'matched', digest }
      : { status: 'conflict', digest, existingDigest };
  } catch {
    return { status: 'conflict', digest, existingDigest: null };
  }
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
  pid: number | null;
  reservation_id: string | null;
  owner_identity_json: string | null;
}

interface CompletedFallback {
  result: unknown;
  expiresAt: number;
}

class ReservationOwnershipLostError extends Error {}

// A finalization write happens after the external side effect. If SQLite fails
// at that exact point, keep the successful receipt in-process so the route can
// return success and same-process transport retries can still replay it. The
// reservation remains in SQLite, preventing another execution by the same key.
const completedFallbacks = new Map<string, CompletedFallback>();

function selectCompletedFallback(key: string, now: number): CompletedFallback | undefined {
  const fallback = completedFallbacks.get(key);
  if (!fallback) return undefined;
  if (fallback.expiresAt <= now) {
    completedFallbacks.delete(key);
    return undefined;
  }
  return fallback;
}

let currentProcessIdentityPromise: Promise<MetadataLockProcessIdentity> | null = null;

async function currentProcessIdentity(): Promise<MetadataLockProcessIdentity> {
  currentProcessIdentityPromise ??= probeMetadataLockProcessIdentity(process.pid).then((probe) => {
    if (probe.state !== 'live') throw new Error('The idempotency owner process identity is unavailable.');
    return probe.identity;
  });
  return currentProcessIdentityPromise;
}

async function reservationOwnerState(row: KeyRow): Promise<'alive' | 'dead' | 'unknown'> {
  if (row.pid === null || !Number.isInteger(row.pid) || row.pid <= 0) return 'dead';
  const probe = await probeMetadataLockProcessIdentity(row.pid);
  if (probe.state === 'absent') return 'dead';
  if (probe.state !== 'live' || !row.owner_identity_json) return 'unknown';
  let recorded: unknown;
  try {
    recorded = JSON.parse(row.owner_identity_json) as unknown;
  } catch {
    return 'unknown';
  }
  if (!isMetadataLockProcessIdentity(recorded)) return 'unknown';
  return sameMetadataLockProcessIdentity(probe.identity, recorded) ? 'alive' : 'dead';
}

function pruneExpired(now: number): void {
  try {
    const sqlite = getSqlite();
    // Completed receipts are ordinary TTL cache entries. In-progress rows are
    // execution locks: elapsed wall time or process death cannot prove that an
    // external side effect did not land, so preserve them until reconciliation.
    sqlite.prepare(
      'DELETE FROM idempotency_keys WHERE result_json IS NOT NULL AND expires_at <= ?',
    ).run(now);

  } catch (error) {
    console.warn('[idempotency] prune failed:', error instanceof Error ? error.message : error);
  }
}

function selectFresh(key: string, now: number): KeyRow | undefined {
  const row = getSqlite()
    .prepare('SELECT result_json, expires_at, pid, reservation_id, owner_identity_json FROM idempotency_keys WHERE key = ?')
    .get(key) as KeyRow | undefined;
  if (!row) return undefined;
  if (row.result_json !== null && row.expires_at <= now) return undefined;
  return row;
}

/** RESERVE: returns true iff this call won the insert (owns the execution). */
function reserve(
  key: string,
  verb: string,
  packetId: string,
  reservationId: string,
  ownerIdentity: MetadataLockProcessIdentity,
  now: number,
  expiresAt: number,
): boolean {
  const info = getSqlite()
    .prepare(
      `INSERT OR IGNORE INTO idempotency_keys
        (key, verb, packet_id, result_json, pid, reservation_id, owner_identity_json, created_at, expires_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(key, verb, packetId, process.pid, reservationId, JSON.stringify(ownerIdentity), now, expiresAt);
  return info.changes > 0;
}

function finalize(
  key: string,
  reservationId: string,
  ownerIdentity: MetadataLockProcessIdentity,
  resultJson: string,
  expiresAt: number,
): void {
  // Clear pid on finalize — a finalized row is a replay cache with no live
  // owner, so it must never look like a reapable in-flight reservation.
  const updated = getSqlite()
    .prepare(
      `UPDATE idempotency_keys SET result_json = ?, pid = NULL, owner_identity_json = NULL, expires_at = ?
       WHERE key = ? AND reservation_id = ? AND pid = ?
         AND owner_identity_json = ? AND result_json IS NULL`,
    )
    .run(resultJson, expiresAt, key, reservationId, process.pid, JSON.stringify(ownerIdentity));
  if (updated.changes !== 1) {
    throw new ReservationOwnershipLostError(
      `Idempotency reservation ownership was lost before ${key} could be finalized.`,
    );
  }
}

function finalizeUnresolved(
  key: string,
  reservationId: string,
  priorPid: number | null,
  priorOwnerIdentityJson: string | null,
  resultJson: string,
  expiresAt: number,
): boolean {
  const updated = getSqlite()
    .prepare(
      `UPDATE idempotency_keys
       SET result_json = ?, pid = NULL, owner_identity_json = NULL, expires_at = ?
       WHERE key = ? AND reservation_id = ? AND pid IS ?
         AND owner_identity_json IS ? AND result_json IS NULL`,
    )
    .run(resultJson, expiresAt, key, reservationId, priorPid, priorOwnerIdentityJson);
  return updated.changes === 1;
}

function release(key: string, reservationId: string): void {
  try {
    getSqlite().prepare('DELETE FROM idempotency_keys WHERE key = ? AND reservation_id = ? AND result_json IS NULL')
      .run(key, reservationId);
  } catch (error) {
    console.warn('[idempotency] release failed:', error instanceof Error ? error.message : error);
  }
}

function inProgressMarker<T>(verb: string, outcomeUnknown = false): T {
  return {
    deduped: true,
    status: 'in_progress',
    verb,
    note: outcomeUnknown
      ? `The prior ${verb} process ended before persisting its receipt. Its outcome is unknown, so it was not re-executed.`
      : `An identical ${verb} is already in progress; not re-executed.`,
    ...(outcomeUnknown ? { outcomeUnknown: true } : {}),
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
    /** Rebuild a terminal receipt from durable verb-specific side-effect truth. */
    reconcileUnresolved?: () => Promise<T | null>;
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

  const completedFallback = selectCompletedFallback(key, now);
  if (completedFallback) {
    return {
      replayed: true,
      inProgress: false,
      persistenceDegraded: true,
      result: completedFallback.result as T,
    };
  }

  const existing = selectFresh(key, now);
  if (existing) {
    if (existing.result_json !== null) {
      return { replayed: true, inProgress: false, result: JSON.parse(existing.result_json) as T };
    }
    const ownerState = await reservationOwnerState(existing);
    const unresolved = ownerState === 'dead';
    if (unresolved && existing.reservation_id && params.reconcileUnresolved) {
      try {
        const reconciled = await params.reconcileUnresolved();
        if (reconciled !== null && finalizeUnresolved(
          key,
          existing.reservation_id,
          existing.pid,
          existing.owner_identity_json,
          JSON.stringify(reconciled),
          expiresAt,
        )) {
          return { replayed: true, inProgress: false, result: reconciled };
        }
      } catch (error) {
        console.warn('[idempotency] unresolved receipt reconciliation failed:', error instanceof Error ? error.message : error);
      }
    }
    return {
      replayed: true,
      inProgress: true,
      ...(unresolved ? { unresolved: true } : {}),
      result: inProgressMarker<T>(verb, unresolved),
    };
  }

  const reservationId = randomUUID();
  const ownerIdentity = await currentProcessIdentity();
  const won = reserve(key, verb, scopeId, reservationId, ownerIdentity, now, expiresAt);
  if (!won) {
    // Lost the reserve race between select and insert — re-read the winner's row.
    const raced = selectFresh(key, now);
    if (raced?.result_json != null) {
      return { replayed: true, inProgress: false, result: JSON.parse(raced.result_json) as T };
    }
    const unresolved = raced ? await reservationOwnerState(raced) === 'dead' : false;
    return {
      replayed: true,
      inProgress: true,
      ...(unresolved ? { unresolved: true } : {}),
      result: inProgressMarker<T>(verb, unresolved),
    };
  }

  let result: T;
  try {
    result = await run();
  } catch (error) {
    // Failures are retryable — drop the reservation so a real retry can run.
    release(key, reservationId);
    throw error;
  }

  // Finalization happens after the side effect. Returning an error here would
  // make official callers mint a fresh key on their next deliberate retry and
  // execute the already-completed mutation again. Keep the successful receipt
  // in-process and return it instead; the live SQLite reservation still blocks
  // re-execution by this key.
  const finalizedExpiresAt = (params.now ?? Date.now()) + ttlMs;
  try {
    finalize(key, reservationId, ownerIdentity, JSON.stringify(result ?? null), finalizedExpiresAt);
  } catch (error) {
    // A storage error leaves our reservation in place, so an in-process
    // fallback can truthfully replay the completed result. If ownership was
    // lost, another execution owns the key and this result must not shadow it.
    if (!(error instanceof ReservationOwnershipLostError)) {
      completedFallbacks.set(key, { result, expiresAt: finalizedExpiresAt });
    }
    console.error(
      '[idempotency] finalization failed after successful execution:',
      error instanceof Error ? error.message : error,
    );
    return {
      replayed: false,
      inProgress: false,
      persistenceDegraded: true,
      result,
    };
  }
  return { replayed: false, inProgress: false, result };
}

/** Test-only: wipe the table. */
export function __resetIdempotencyStoreForTests(): void {
  completedFallbacks.clear();
  try {
    getSqlite().prepare('DELETE FROM idempotency_keys').run();
  } catch {
    // DB not initialized — nothing to reset.
  }
}
