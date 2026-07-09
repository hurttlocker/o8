import { env } from './env.js';

/**
 * Clerk Backend API client wrapper (#1519).
 *
 * The ONLY job of this module is to resolve a Clerk user id to their linked
 * GitHub external account, so an entitlement can key on the STABLE GitHub
 * identity rather than only the exact Clerk user id stamped in Stripe metadata.
 * A duplicate Clerk user on the same GitHub account (or a Clerk-instance
 * migration) otherwise strands a real founder's entitlement.
 *
 * This is the mock boundary for the identity-resolution tests: everything above
 * it takes a `ClerkBackendClient` so the fallback + migration logic is exercised
 * against a fake that returns a canned GitHub account — no network in tests.
 *
 * ── The one network call (Clerk Backend API — documented shape) ──────────────
 *   GET https://api.clerk.com/v1/users/{user_id}
 *   Authorization: Bearer <CLERK_SECRET_KEY>
 *   → 200 { ..., external_accounts: [ {
 *       provider: 'oauth_github',      // GitHub OAuth connection
 *       provider_user_id: '583231',    // GitHub numeric account id (STABLE)
 *       username: 'octocat',           // GitHub login (may change; debug only)
 *       ...
 *     }, ... ] }
 * The provider string for a GitHub connection is `oauth_github`; we match on the
 * substring `github` to be resilient to any future provider naming. The
 * `provider_user_id` is GitHub's immutable numeric id — the value we persist and
 * match on. Marked clearly because it is the single unverified external call in
 * this change: if the field names ever drift, only this function changes.
 */

export interface GithubExternalAccount {
  /** GitHub's immutable numeric account id (Clerk `provider_user_id`), as a string. */
  githubAccountId: string;
  /** GitHub login/username at resolution time — debug only, never trusted for auth. */
  githubLogin: string | null;
}

export interface ClerkBackendClient {
  /** Resolve a Clerk user id to their GitHub external account, or null. Never throws. */
  resolveGithubAccount(clerkUserId: string): Promise<GithubExternalAccount | null>;
}

const CLERK_API_BASE = 'https://api.clerk.com/v1';

// In-memory cache userId → resolved account (or null), ~10min TTL. Purely a
// rate-limit shield so a hot read-path fallback loop can't hammer the Clerk API
// (the process is long-lived on Railway). A `null` is cached too — that is the
// common "caller has no matching entitlement" case we specifically want to stop
// re-querying on every focus/reload.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: GithubExternalAccount | null }>();

/** Test/ops seam — drop the resolution cache. */
export function clearClerkBackendCache(): void {
  cache.clear();
}

function extractGithubAccount(user: unknown): GithubExternalAccount | null {
  const accounts = (user as { external_accounts?: unknown })?.external_accounts;
  if (!Array.isArray(accounts)) return null;
  for (const raw of accounts) {
    const a = raw as { provider?: unknown; provider_user_id?: unknown; username?: unknown };
    const provider = typeof a?.provider === 'string' ? a.provider.toLowerCase() : '';
    if (!provider.includes('github')) continue;
    const id = a?.provider_user_id;
    if (id === null || id === undefined || String(id).trim() === '') continue;
    return {
      githubAccountId: String(id),
      githubLogin: typeof a?.username === 'string' && a.username ? a.username : null,
    };
  }
  return null;
}

async function fetchGithubAccount(clerkUserId: string): Promise<GithubExternalAccount | null> {
  if (!env.CLERK_SECRET_KEY) return null;
  const res = await fetch(`${CLERK_API_BASE}/users/${encodeURIComponent(clerkUserId)}`, {
    headers: { Authorization: `Bearer ${env.CLERK_SECRET_KEY}` },
  });
  if (!res.ok) {
    console.warn(`[clerk-backend] users.getUser ${clerkUserId} → HTTP ${res.status}`);
    return null;
  }
  const user = (await res.json()) as unknown;
  return extractGithubAccount(user);
}

export const clerkBackend: ClerkBackendClient = {
  async resolveGithubAccount(clerkUserId: string): Promise<GithubExternalAccount | null> {
    if (!clerkUserId) return null;
    const hit = cache.get(clerkUserId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
    let value: GithubExternalAccount | null = null;
    try {
      value = await fetchGithubAccount(clerkUserId);
    } catch (err) {
      // Never throw — every caller is best-effort. A transient failure caches
      // null for the TTL; that is acceptable for backfill and a no-op for the
      // fallback (it simply won't migrate this cycle).
      console.warn(
        '[clerk-backend] resolveGithubAccount failed:',
        err instanceof Error ? err.message : err,
      );
      value = null;
    }
    cache.set(clerkUserId, { at: Date.now(), value });
    return value;
  },
};
