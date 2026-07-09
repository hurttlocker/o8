import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { clerkBackend, type ClerkBackendClient } from './clerk-backend.js';
import { db } from './db/client.js';
import { founders, subscriptions } from './db/schema.js';
import type { EntitlementKind, IdentityStore } from './identity-core.js';

/**
 * Drizzle-backed wiring for the GitHub-identity fallback (#1519). The pure
 * decision logic + interfaces live in `identity-core.ts` (env/db-free, so it is
 * testable in isolation); this module supplies the production `IdentityStore`,
 * the best-effort write-path backfill, and the admin backfill walk, then
 * re-exports the core so callers have a single import surface.
 */

export * from './identity-core.js';

// ── Production drizzle-backed store ───────────────────────────────────────────

export const dbIdentityStore: IdentityStore = {
  async findSubscriptionByGithubAccountId(githubAccountId) {
    const rows = await db
      .select({ id: subscriptions.id, clerkUserId: subscriptions.clerkUserId })
      .from(subscriptions)
      .where(
        and(eq(subscriptions.githubAccountId, githubAccountId), isNull(subscriptions.revokedAt)),
      )
      .limit(1);
    const r = rows[0];
    return r ? { kind: 'subscription', id: r.id, clerkUserId: r.clerkUserId } : null;
  },
  async findFounderByGithubAccountId(githubAccountId) {
    const rows = await db
      .select({ id: founders.id, clerkUserId: founders.clerkUserId })
      .from(founders)
      .where(
        and(
          eq(founders.githubAccountId, githubAccountId),
          eq(founders.status, 'active'),
          isNull(founders.revokedAt),
        ),
      )
      .limit(1);
    const r = rows[0];
    return r ? { kind: 'founder', id: r.id, clerkUserId: r.clerkUserId } : null;
  },
  async migrateClerkUserId(ref, newClerkUserId) {
    if (ref.kind === 'subscription') {
      await db
        .update(subscriptions)
        .set({ clerkUserId: newClerkUserId, updatedAt: new Date() })
        .where(eq(subscriptions.id, ref.id));
    } else {
      await db
        .update(founders)
        .set({ clerkUserId: newClerkUserId, updatedAt: new Date() })
        .where(eq(founders.id, ref.id));
    }
  },
};

// ── Best-effort write-path backfill (never blocks the payment path) ───────────

/**
 * Backfill github_account_id/github_login for a row from its clerkUserId via the
 * Clerk Backend API. Idempotent (updates only when the column is still null) and
 * fire-and-forget safe — every failure is swallowed with a log line so the
 * checkout / account-fetch path is never blocked on a Clerk API hiccup.
 */
export async function backfillGithubForRow(
  kind: EntitlementKind,
  rowId: string,
  clerkUserId: string | null,
  clerk: ClerkBackendClient = clerkBackend,
): Promise<void> {
  try {
    if (!clerkUserId) return;
    const gh = await clerk.resolveGithubAccount(clerkUserId);
    if (!gh) return;
    if (kind === 'subscription') {
      await db
        .update(subscriptions)
        .set({ githubAccountId: gh.githubAccountId, githubLogin: gh.githubLogin, updatedAt: new Date() })
        .where(and(eq(subscriptions.id, rowId), isNull(subscriptions.githubAccountId)));
    } else {
      await db
        .update(founders)
        .set({ githubAccountId: gh.githubAccountId, githubLogin: gh.githubLogin, updatedAt: new Date() })
        .where(and(eq(founders.id, rowId), isNull(founders.githubAccountId)));
    }
  } catch (err) {
    console.warn(
      `[identity] github backfill (${kind} ${rowId}) skipped:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Admin backfill walk (idempotent, dry-run capable) ─────────────────────────

export interface BackfillSummary {
  dryRun: boolean;
  scanned: { founders: number; subscriptions: number };
  resolved: number;
  updated: number;
  skipped: number;
}

/**
 * Walk existing founders + subscriptions rows that have a clerkUserId but no
 * github_account_id yet, resolve each via the Clerk Backend API, and populate
 * the columns. Idempotent (only touches null rows). `dryRun` resolves + counts
 * without writing. Returns a summary.
 */
export async function runGithubBackfill(
  opts: { dryRun: boolean; limit?: number },
  clerk: ClerkBackendClient = clerkBackend,
): Promise<BackfillSummary> {
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 500;
  const summary: BackfillSummary = {
    dryRun: opts.dryRun,
    scanned: { founders: 0, subscriptions: 0 },
    resolved: 0,
    updated: 0,
    skipped: 0,
  };

  const subRows = await db
    .select({ id: subscriptions.id, clerkUserId: subscriptions.clerkUserId })
    .from(subscriptions)
    .where(and(isNull(subscriptions.githubAccountId), isNotNull(subscriptions.clerkUserId)))
    .limit(limit);
  const founderRows = await db
    .select({ id: founders.id, clerkUserId: founders.clerkUserId })
    .from(founders)
    .where(and(isNull(founders.githubAccountId), isNotNull(founders.clerkUserId)))
    .limit(limit);

  summary.scanned.subscriptions = subRows.length;
  summary.scanned.founders = founderRows.length;

  for (const r of subRows) {
    const gh = r.clerkUserId ? await clerk.resolveGithubAccount(r.clerkUserId) : null;
    if (!gh) {
      summary.skipped += 1;
      continue;
    }
    summary.resolved += 1;
    if (!opts.dryRun) {
      await db
        .update(subscriptions)
        .set({ githubAccountId: gh.githubAccountId, githubLogin: gh.githubLogin, updatedAt: new Date() })
        .where(and(eq(subscriptions.id, r.id), isNull(subscriptions.githubAccountId)));
      summary.updated += 1;
    }
  }

  for (const r of founderRows) {
    const gh = r.clerkUserId ? await clerk.resolveGithubAccount(r.clerkUserId) : null;
    if (!gh) {
      summary.skipped += 1;
      continue;
    }
    summary.resolved += 1;
    if (!opts.dryRun) {
      await db
        .update(founders)
        .set({ githubAccountId: gh.githubAccountId, githubLogin: gh.githubLogin, updatedAt: new Date() })
        .where(and(eq(founders.id, r.id), isNull(founders.githubAccountId)));
      summary.updated += 1;
    }
  }

  return summary;
}
