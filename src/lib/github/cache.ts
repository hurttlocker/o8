/**
 * GitHub API Response Cache
 *
 * Shared in-memory cache for GitHub CLI responses.
 * Prevents hammering the GitHub API (5000 req/hr GraphQL limit)
 * across dashboard page loads, polling, and HMR restarts.
 */

interface CacheEntry<T> {
  data: T;
  ts: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

/** Default TTL: 5 minutes — repo data rarely changes faster than this */
const DEFAULT_TTL_MS = 5 * 60 * 1000;

/** Longer TTL for slow-changing data (CI runs, deployments) */
export const SLOW_TTL_MS = 10 * 60 * 1000;

/**
 * Get a cached response, or return null if stale/missing.
 */
export function getCached<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) {
    cache.delete(key);
    return null;
  }
  return entry.data as T;
}

/**
 * Store a response in cache.
 */
export function setCached<T>(key: string, data: T): void {
  cache.set(key, { data, ts: Date.now() });
}

/**
 * Invalidate a specific cache entry or all entries for a repo.
 */
export function invalidate(keyOrPrefix: string): void {
  if (cache.has(keyOrPrefix)) {
    cache.delete(keyOrPrefix);
    return;
  }
  // Prefix match — invalidate all keys starting with the given string
  for (const key of cache.keys()) {
    if (key.startsWith(keyOrPrefix)) {
      cache.delete(key);
    }
  }
}

/**
 * Get cache stats (for debugging).
 */
export function cacheStats(): { entries: number; keys: string[] } {
  return { entries: cache.size, keys: [...cache.keys()] };
}
