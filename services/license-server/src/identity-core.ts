import type { ClerkBackendClient } from './clerk-backend.js';

/**
 * GitHub-identity resolution + one-way clerkUserId migration — the PURE core
 * (#1519). Deliberately imports nothing with side effects (no db, no env) so it
 * is testable in isolation with in-memory fakes, matching the env-free
 * `contract-test.ts` precedent. The `ClerkBackendClient` wrapper is the single
 * mock boundary; the drizzle-backed `IdentityStore` + backfill live in
 * `identity.ts`, which re-exports this module.
 *
 * Why this exists: founder / subscription rows historically key ONLY on the
 * exact clerkUserId stamped in Stripe checkout metadata. A duplicate Clerk user
 * on the same GitHub account — or a Clerk-instance migration — strands the
 * entitlement (the direct lookup 404s and the desktop silently falls back to a
 * free token). The STABLE GitHub account id is the recovery key.
 */

export type EntitlementKind = 'subscription' | 'founder';

export interface EntitlementRowRef {
  kind: EntitlementKind;
  /** Primary key of the matched row (subscription id / founders session id). */
  id: string;
  /** The clerkUserId currently on the row (the one that no longer matches the caller). */
  clerkUserId: string | null;
}

export interface IdentityStore {
  /** Active (non-revoked) subscription whose github_account_id matches, else null. */
  findSubscriptionByGithubAccountId(githubAccountId: string): Promise<EntitlementRowRef | null>;
  /** Active (non-revoked) founder whose github_account_id matches, else null. */
  findFounderByGithubAccountId(githubAccountId: string): Promise<EntitlementRowRef | null>;
  /** One-way migrate the matched row's clerk_user_id to the caller's id. */
  migrateClerkUserId(ref: EntitlementRowRef, newClerkUserId: string): Promise<void>;
}

export interface GithubMigrationResult {
  kind: EntitlementKind;
  githubAccountId: string;
  oldClerkUserId: string | null;
  /** True when a row's clerkUserId was actually rewritten to the caller. */
  migrated: boolean;
}

/**
 * Read-path fallback: the caller's clerkUserId had NO direct entitlement.
 * Resolve their GitHub external account via Clerk; if a founders/subscriptions
 * row matches that githubAccountId, honor it AND migrate that row's clerkUserId
 * to the caller (one-way, logged as `identity_migrated` old→new). Subscription
 * wins over founder, matching the /account/license primary order.
 *
 * Returns the matched kind so the caller can re-run its primary (now-migrated)
 * lookup and mint, or null when nothing resolves. Never throws.
 */
export async function resolveAndMigrateByGithub(
  callerClerkUserId: string,
  clerk: ClerkBackendClient,
  store: IdentityStore,
): Promise<GithubMigrationResult | null> {
  if (!callerClerkUserId) return null;

  const gh = await clerk.resolveGithubAccount(callerClerkUserId).catch(() => null);
  if (!gh) return null;

  const match =
    (await store.findSubscriptionByGithubAccountId(gh.githubAccountId)) ??
    (await store.findFounderByGithubAccountId(gh.githubAccountId));
  if (!match) return null;

  // Already the caller's id (shouldn't happen — the primary path 404'd — but be
  // safe): honor without a redundant write.
  if (match.clerkUserId === callerClerkUserId) {
    return {
      kind: match.kind,
      githubAccountId: gh.githubAccountId,
      oldClerkUserId: match.clerkUserId,
      migrated: false,
    };
  }

  await store.migrateClerkUserId(match, callerClerkUserId);
  console.log(
    `[identity] identity_migrated ${match.kind} id=${match.id} ` +
      `old=${match.clerkUserId ?? 'null'} new=${callerClerkUserId} github=${gh.githubAccountId}`,
  );
  return {
    kind: match.kind,
    githubAccountId: gh.githubAccountId,
    oldClerkUserId: match.clerkUserId,
    migrated: true,
  };
}
