/**
 * In-process idempotency cache (#623).
 *
 * Used by `o8_merge_preview` / `approve_and_merge` to short-circuit
 * duplicate calls that arrive within a 5-minute window. Callers pass an
 * optional `idempotencyKey`; on a hit the cached result is replayed
 * verbatim, letting retrying clients avoid running a merge twice.
 *
 * Intentionally in-memory only — spec says "no DB table, prune-on-access".
 * The cache lives inside a single node process so a restart invalidates
 * all keys, which is the correct behavior for a merge-in-flight.
 */

const DEFAULT_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
  result: T;
  expiresAt: number;
}

// Shared across all call sites inside a single node process.
const store = new Map<string, CacheEntry<unknown>>();

/** Return the cached result if the key is present and fresh; prune expired. */
export function getIdempotent<T>(key: string, now: number = Date.now()): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    // Prune-on-access — the spec requires this rather than a timer.
    store.delete(key);
    return undefined;
  }
  return entry.result as T;
}

/** Store a result under `key` with the given TTL (defaults to 5 minutes). */
export function setIdempotent<T>(
  key: string,
  result: T,
  ttlMs: number = DEFAULT_TTL_MS,
  now: number = Date.now(),
): void {
  store.set(key, { result, expiresAt: now + ttlMs });
}

/**
 * Prune entries whose TTL has elapsed. Called lazily by `getIdempotent`
 * for the hit path; exported so opportunistic callers can sweep the map
 * without forcing a lookup.
 */
export function pruneExpired(now: number = Date.now()): number {
  let removed = 0;
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** Test-only: clear the entire cache. Not wired anywhere else. */
export function __resetIdempotencyCacheForTests(): void {
  store.clear();
}
