/**
 * Durable correlation journal for one reset_packet / retry_packet request (#2313).
 *
 * The persisted idempotency reservation proves that a request was ACCEPTED; it
 * says nothing about what that request durably did. Retry salvage stamps its
 * generation onto the packet (`releaseStatePayload.source = retry_salvage:<G>`),
 * but nothing linked that generation back to the accepted request — so when the
 * owner exited between the hold and the receipt, the reservation had no
 * supported path to a final result and stayed 409 `outcome_unknown` forever.
 *
 * This journal is that missing edge, and nothing more. Per request key it
 * records the generation the request intends to use, the rehydratable salvage
 * guard once the hold lands, a non-repeatable checkpoint taken before the bind
 * writes its first side effect, and the terminal receipt once the effect
 * settles. Phase writes happen inside the packet lifecycle lease, closing the
 * window after lease release and before idempotency receipt finalization.
 * Refusal notes may be written outside that lease, so they compare the exact
 * stored snapshot and never overwrite newer progress.
 *
 * Phases only ever move forward. A `binding` or `completed` record can never be
 * overwritten by a later `started`/`guarded` write, because that would erase
 * the evidence that a partial effect may exist.
 *
 * Storage reuses the existing `idempotency_keys` table under a namespaced key,
 * the same seam `bindIdempotencyClientMutation` uses for durable verb-specific
 * JSON. No schema migration.
 *
 * Retention is deliberately NOT a fixed TTL. An unfinished request lives
 * indefinitely, and its journal is the only evidence that can ever settle it,
 * so journal rows are written past the store's TTL prune and are removed only
 * once the request COMPLETED and its own reservation is settled (finalized or
 * gone) — and then only after a bounded grace period.
 */

import { createHash } from 'node:crypto';
import { getDb, getSqlite } from '@/lib/db';
import { isResetReceipt, type ResetReceipt } from './reset-receipt';
import type { RetrySalvageBindCheckpoint, RetrySalvageGuard } from './retry-salvage';

const JOURNAL_VERB = 'reset_packet.journal';
/** Grace period after a completed request's reservation settles. */
const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Journal rows must outlive the store's own TTL prune. */
const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

export type ResetRequestJournalPhase = 'started' | 'guarded' | 'binding' | 'completed';

const PHASE_RANK: Record<ResetRequestJournalPhase, number> = {
  started: 0,
  guarded: 1,
  binding: 2,
  completed: 3,
};

/** Re-exported for readers of the journal contract. */
export type ResetRequestBindCheckpoint = RetrySalvageBindCheckpoint;

export interface ResetRequestJournalEntry {
  /**
   * `started`   — accepted, generation minted, nothing stamped yet.
   * `guarded`   — the retry-salvage hold landed under `guard.generation`.
   * `binding`   — about to bind committed work; a partial effect may exist.
   * `completed` — the request reached a terminal receipt.
   */
  phase: ResetRequestJournalPhase;
  packetId: string;
  clearWorktree: boolean;
  generation: string;
  guard?: RetrySalvageGuard;
  bind?: RetrySalvageBindCheckpoint;
  receipt?: ResetReceipt;
  /** Why the last reconciliation attempt refused. Never a terminal outcome. */
  held?: { reason: string; at: number };
  updatedAt: number;
}

/**
 * `absent` means no correlation was ever recorded; `unreadable` means one was,
 * but it cannot be trusted. They must not be conflated: treating a corrupt
 * journal as absent would let caller-supplied evidence override a correlation
 * this request actually made.
 */
export type ResetRequestJournalRead =
  | { status: 'absent' }
  | { status: 'unreadable'; reason: string }
  | { status: 'present'; entry: ResetRequestJournalEntry };

function journalKey(requestKey: string): string {
  return `${JOURNAL_VERB}:${createHash('sha256').update(requestKey).digest('hex')}`;
}

function isRetrySalvageGuard(value: unknown): value is RetrySalvageGuard {
  if (!value || typeof value !== 'object') return false;
  const guard = value as Record<string, unknown>;
  return (guard.store === 'current' || guard.store === 'registry')
    && typeof guard.missionId === 'string'
    && typeof guard.generation === 'string'
    && guard.generation.length > 0
    && typeof guard.holdReason === 'string'
    && typeof guard.referenceLabel === 'string'
    && Array.isArray(guard.laneIds)
    && guard.laneIds.every((laneId) => typeof laneId === 'string')
    && (guard.candidateLane === null || (typeof guard.candidateLane === 'object' && guard.candidateLane !== null))
    && (guard.laneId === null || typeof guard.laneId === 'string')
    && (guard.sessionKey === null || typeof guard.sessionKey === 'string')
    && (guard.worktreePath === null || typeof guard.worktreePath === 'string');
}

function isBindCheckpoint(value: unknown): value is RetrySalvageBindCheckpoint {
  if (!value || typeof value !== 'object') return false;
  const bind = value as Record<string, unknown>;
  return typeof bind.candidateLaneId === 'string'
    && bind.candidateLaneId.length > 0
    && typeof bind.worktreePath === 'string'
    && bind.worktreePath.length > 0;
}

function parseJournalEntry(value: unknown): ResetRequestJournalEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.phase !== 'string' || !Object.hasOwn(PHASE_RANK, entry.phase)) return null;
  if (typeof entry.packetId !== 'string' || !entry.packetId) return null;
  if (typeof entry.generation !== 'string' || !entry.generation) return null;
  if (typeof entry.clearWorktree !== 'boolean') return null;
  if (typeof entry.updatedAt !== 'number') return null;
  if (entry.guard !== undefined && !isRetrySalvageGuard(entry.guard)) return null;
  if (entry.bind !== undefined && !isBindCheckpoint(entry.bind)) return null;
  if (entry.receipt !== undefined && !isResetReceipt(entry.receipt)) return null;
  const guard = entry.guard as RetrySalvageGuard | undefined;
  const bind = entry.bind as RetrySalvageBindCheckpoint | undefined;
  if (guard && guard.generation !== entry.generation) return null;
  if (guard?.candidateLane && (typeof guard.candidateLane.id !== 'string'
    || !guard.candidateLane.id || guard.candidateLane.packetId !== entry.packetId)) return null;
  if (bind && (!guard?.candidateLane
    || bind.candidateLaneId !== guard.candidateLane.id
    || bind.worktreePath !== guard.candidateLane.worktreePath)) return null;
  if (entry.phase === 'started' && (guard !== undefined || bind !== undefined || entry.receipt !== undefined)) return null;
  if (entry.phase === 'guarded' && (guard === undefined || bind !== undefined || entry.receipt !== undefined)) return null;
  if (entry.phase === 'binding' && (guard === undefined || bind === undefined || entry.receipt !== undefined)) return null;
  if (entry.phase === 'completed' && entry.receipt === undefined) return null;
  return entry as unknown as ResetRequestJournalEntry;
}

/**
 * Read the journal for one request key, distinguishing "never recorded" from
 * "recorded but not trustworthy".
 */
export function readResetRequestJournal(requestKey: string): ResetRequestJournalRead {
  if (!getDb()) return { status: 'unreadable', reason: 'the correlation store is unavailable' };
  let row: { result_json: string | null } | undefined;
  try {
    row = getSqlite()
      .prepare('SELECT result_json FROM idempotency_keys WHERE key = ?')
      .get(journalKey(requestKey)) as { result_json: string | null } | undefined;
  } catch (error) {
    return {
      status: 'unreadable',
      reason: `the correlation store could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!row) return { status: 'absent' };
  if (!row.result_json) return { status: 'unreadable', reason: 'the correlation record is empty' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.result_json) as unknown;
  } catch {
    return { status: 'unreadable', reason: 'the correlation record is not valid JSON' };
  }
  const entry = parseJournalEntry(parsed);
  return entry
    ? { status: 'present', entry }
    : { status: 'unreadable', reason: 'the correlation record has an unrecognized shape' };
}

/**
 * Drop journals whose request completed AND whose own reservation is settled.
 * A reservation still holding an unresolved guard keeps its journal forever:
 * that record is the only thing that can ever answer it.
 */
function pruneSettledResetJournals(now: number): void {
  const sqlite = getSqlite();
  const rows = sqlite.prepare(
    'SELECT key, reservation_id, result_json FROM idempotency_keys WHERE verb = ?',
  ).all(JOURNAL_VERB) as Array<{ key: string; reservation_id: string | null; result_json: string | null }>;
  const drop = sqlite.prepare('DELETE FROM idempotency_keys WHERE key = ?');
  for (const row of rows) {
    if (!row.result_json || !row.reservation_id) continue;
    let entry: ResetRequestJournalEntry | null = null;
    try {
      entry = parseJournalEntry(JSON.parse(row.result_json) as unknown);
    } catch {
      continue;
    }
    // Unreadable rows are kept: they still fail recovery closed, and deleting
    // them would silently downgrade the request to "no correlation recorded".
    if (!entry || entry.phase !== 'completed') continue;
    if (now - entry.updatedAt < SETTLED_RETENTION_MS) continue;
    const reservation = sqlite
      .prepare('SELECT result_json FROM idempotency_keys WHERE key = ?')
      .get(row.reservation_id) as { result_json: string | null } | undefined;
    if (reservation && reservation.result_json === null) continue;
    drop.run(row.key);
  }
}

function persistJournal(requestKey: string, entry: ResetRequestJournalEntry): void {
  const now = entry.updatedAt;
  // `reservation_id` holds the reservation key this journal explains, so
  // retention can ask whether that reservation is still unresolved.
  getSqlite().prepare(
    `INSERT INTO idempotency_keys
       (key, verb, packet_id, result_json, pid, reservation_id, owner_identity_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       result_json = excluded.result_json,
       packet_id = excluded.packet_id,
       reservation_id = excluded.reservation_id,
       expires_at = excluded.expires_at`,
  ).run(journalKey(requestKey), JOURNAL_VERB, entry.packetId, JSON.stringify(entry), requestKey, now, NEVER_EXPIRES);
}

type JournalAdvance =
  | { ok: true; existing: ResetRequestJournalEntry | null }
  | { ok: false; reason: string };

/**
 * A phase may only advance, and an advancing write may never DROP correlation
 * the request already recorded. A completion that omitted the guard and the
 * bind checkpoint would leave a record whose generation still matches but whose
 * candidate is unknown — and an unresolved replay would then accept any
 * candidate evidence. Carry both forward instead.
 */
function planJournalAdvance(
  requestKey: string,
  next: Omit<ResetRequestJournalEntry, 'updatedAt'>,
): JournalAdvance {
  const existing = readResetRequestJournal(requestKey);
  if (existing.status === 'unreadable') {
    return { ok: false, reason: `the existing correlation record is unusable — ${existing.reason}` };
  }
  const prior = existing.status === 'present' ? existing.entry : null;
  if (prior) {
    if (PHASE_RANK[next.phase] < PHASE_RANK[prior.phase]) {
      return { ok: false, reason: `it would regress ${prior.phase} to ${next.phase}` };
    }
    if (next.packetId !== prior.packetId
      || next.clearWorktree !== prior.clearWorktree
      || next.generation !== prior.generation) {
      return { ok: false, reason: 'it would replace the accepted request identity' };
    }
    if (prior.guard && next.guard
      && ((next.guard.candidateLane?.id ?? null) !== (prior.guard.candidateLane?.id ?? null)
        || next.guard.candidateLane?.worktreePath !== prior.guard.candidateLane?.worktreePath)) {
      return { ok: false, reason: 'it would replace the recorded candidate lane' };
    }
    if (prior.bind && next.bind
      && (next.bind.candidateLaneId !== prior.bind.candidateLaneId
        || next.bind.worktreePath !== prior.bind.worktreePath)) {
      return { ok: false, reason: 'it would replace the recorded bind checkpoint' };
    }
  }
  const candidate = { ...carryCorrelationForward(next, prior), updatedAt: Date.now() };
  if (!parseJournalEntry(candidate)) {
    return { ok: false, reason: 'its phase or correlation fields are inconsistent' };
  }
  return { ok: true, existing: prior };
}

function carryCorrelationForward(
  entry: Omit<ResetRequestJournalEntry, 'updatedAt'>,
  existing: ResetRequestJournalEntry | null,
): Omit<ResetRequestJournalEntry, 'updatedAt'> {
  if (!existing) return entry;
  return {
    ...entry,
    guard: entry.guard ?? existing.guard,
    bind: entry.bind ?? existing.bind,
  };
}

/**
 * Upsert the journal for one request key. A journal write must never break the
 * reset it is describing, so a storage failure only degrades recoverability.
 */
export function writeResetRequestJournal(
  requestKey: string,
  entry: Omit<ResetRequestJournalEntry, 'updatedAt'>,
): void {
  if (!getDb()) return;
  try {
    const advance = planJournalAdvance(requestKey, entry);
    if (!advance.ok) {
      console.warn(`[reset-recovery] refused a correlation write for ${entry.packetId}: ${advance.reason}`);
      return;
    }
    const now = Date.now();
    persistJournal(requestKey, { ...carryCorrelationForward(entry, advance.existing), updatedAt: now });
    pruneSettledResetJournals(now);
  } catch (error) {
    console.warn('[reset-recovery] journal write failed:', error instanceof Error ? error.message : error);
  }
}

export class ResetRequestJournalUnavailableError extends Error {}

/**
 * Persist a checkpoint that MUST exist before the caller makes an irreversible
 * change, and verify it by reading it back. Unlike the best-effort writer this
 * throws: a bind that cannot record its checkpoint must stop before creating or
 * retiring anything, or an interrupted bind becomes unreconcilable.
 */
export function commitResetRequestJournal(
  requestKey: string,
  entry: Omit<ResetRequestJournalEntry, 'updatedAt'>,
): void {
  if (!getDb()) {
    throw new ResetRequestJournalUnavailableError(
      'The reset correlation store is unavailable; the bind checkpoint could not be recorded.',
    );
  }
  const advance = planJournalAdvance(requestKey, entry);
  if (!advance.ok) {
    throw new ResetRequestJournalUnavailableError(
      `The reset bind checkpoint for ${entry.packetId} was refused: ${advance.reason}.`,
    );
  }
  const now = Date.now();
  try {
    persistJournal(requestKey, { ...carryCorrelationForward(entry, advance.existing), updatedAt: now });
  } catch (error) {
    throw new ResetRequestJournalUnavailableError(
      `The reset bind checkpoint could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const verified = readResetRequestJournal(requestKey);
  if (verified.status !== 'present'
    || verified.entry.phase !== entry.phase
    || verified.entry.updatedAt !== now) {
    throw new ResetRequestJournalUnavailableError(
      'The reset bind checkpoint could not be verified after writing.',
    );
  }
}

/**
 * Record why a reconciliation refused, without changing the phase. This is the
 * durable, precise "held" evidence for a request that cannot be settled — it is
 * never a terminal outcome and never implies success.
 */
export function recordResetRequestHold(requestKey: string, reason: string): void {
  if (!getDb()) return;
  try {
    const sqlite = getSqlite();
    const key = journalKey(requestKey);
    const row = sqlite.prepare('SELECT result_json FROM idempotency_keys WHERE key = ? AND verb = ?')
      .get(key, JOURNAL_VERB) as { result_json: string | null } | undefined;
    if (!row?.result_json) return;
    const entry = parseJournalEntry(JSON.parse(row.result_json) as unknown);
    if (!entry) return;
    // A duplicate can refuse before taking the packet lease. If the original
    // request advanced meanwhile, discard this stale diagnostic instead of
    // replacing its checkpoint or terminal receipt. Zero changes is safe.
    sqlite.prepare('UPDATE idempotency_keys SET result_json = ? WHERE key = ? AND verb = ? AND result_json = ?')
      .run(JSON.stringify({ ...entry, held: { reason, at: Date.now() } }), key, JOURNAL_VERB, row.result_json);
  } catch (error) {
    console.warn('[reset-recovery] hold record failed:', error instanceof Error ? error.message : error);
  }
}

/** The precise reason the last reconciliation refused, if one was recorded. */
export function readResetRequestHold(requestKey: string): string | null {
  const existing = readResetRequestJournal(requestKey);
  if (existing.status === 'unreadable') return existing.reason;
  if (existing.status !== 'present') return null;
  return existing.entry.held?.reason ?? null;
}
