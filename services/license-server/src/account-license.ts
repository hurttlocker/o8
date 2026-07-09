import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { clerkBackend } from './clerk-backend.js';
import { db } from './db/client.js';
import { founders, proxyUsage, subscriptions } from './db/schema.js';
import { env } from './env.js';
import { backfillGithubForRow, dbIdentityStore, resolveAndMigrateByGithub } from './identity.js';
import { mintLicense, type Plan } from './mint.js';
import { DAILY_CAP_MICRO_USD } from './proxy.js';
import { verifyClerkSession } from './clerk-verify.js';
import { founderTier } from './founding.js';

/**
 * Today's managed-Brain usage for one account (the plan-token `sub`, which is the
 * Clerk user id). Drives the "Today on the Brain" fair-use meter on the web
 * console — calls + spend vs the plan's daily ceiling. Best-effort: callers
 * swallow errors so usage never blocks the license response.
 */
export type TodayUsage = {
  callsToday: number;
  spentMicroUsd: number;
  capMicroUsd: number;
  byKind: { kind: string; calls: number; spentMicroUsd: number }[];
};

async function todayUsage(sub: string, plan: Plan): Promise<TodayUsage> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const rows = await db
    .select({
      kind: proxyUsage.kind,
      calls: sql<string>`count(*)`,
      spent: sql<string>`coalesce(sum(${proxyUsage.costMicroUsd}), 0)`,
    })
    .from(proxyUsage)
    .where(and(eq(proxyUsage.sub, sub), gte(proxyUsage.createdAt, startOfDay)))
    .groupBy(proxyUsage.kind);

  let callsToday = 0;
  let spentMicroUsd = 0;
  const byKind = rows.map((r) => {
    const calls = Number(r.calls);
    const spent = Number(r.spent);
    callsToday += calls;
    spentMicroUsd += spent;
    return { kind: r.kind, calls, spentMicroUsd: spent };
  });
  return { callsToday, spentMicroUsd, capMicroUsd: DAILY_CAP_MICRO_USD[plan], byKind };
}

/**
 * Resolve an ACTIVE (non-revoked) subscription for this Clerk user and build the
 * license response, or null when none. Best-effort backfills the row's STABLE
 * GitHub identity when it's still missing, so the #1519 fallback can key on it.
 */
async function subscriptionResponse(c: Context, clerkUserId: string): Promise<Response | null> {
  const subs = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.clerkUserId, clerkUserId), isNull(subscriptions.revokedAt)))
    .limit(1);
  if (subs.length === 0) return null;

  const sub = subs[0]!;
  if (!sub.githubAccountId) void backfillGithubForRow('subscription', sub.id, clerkUserId);

  const days = sub.currentPeriodEnd
    ? Math.max(1, Math.ceil((sub.currentPeriodEnd.getTime() - Date.now()) / 86_400_000))
    : 35;
  const license = await mintLicense({ plan: sub.plan as Plan, sub: clerkUserId, days });
  const usage = await todayUsage(clerkUserId, sub.plan as Plan).catch(() => null);
  return c.json({ license, plan: sub.plan, source: 'subscription', usage });
}

/**
 * Resolve an ACTIVE Founding Operator purchase (over_cap rows never get a token)
 * for this Clerk user and build the license response, or null when none.
 * Best-effort backfills the row's STABLE GitHub identity when it's still missing.
 */
async function founderResponse(c: Context, clerkUserId: string): Promise<Response | null> {
  const founderRows = await db
    .select()
    .from(founders)
    .where(
      and(
        eq(founders.clerkUserId, clerkUserId),
        eq(founders.status, 'active'),
        isNull(founders.revokedAt),
      ),
    )
    .limit(1);
  if (founderRows.length === 0) return null;

  const f = founderRows[0]!;
  if (!f.githubAccountId) void backfillGithubForRow('founder', f.id, clerkUserId);

  const license = await mintLicense({
    plan: 'founder',
    sub: clerkUserId,
    days: Math.max(1, env.FOUNDER_LICENSE_DAYS),
  });
  const usage = await todayUsage(clerkUserId, 'founder').catch(() => null);
  return c.json({
    license,
    plan: 'founder',
    source: 'founding',
    founder: { operatorNumber: f.operatorNumber, tier: founderTier(f.operatorNumber).tier },
    usage,
  });
}

/**
 * POST /account/license — return THIS signed-in user's license token.
 *
 * Auth: the caller (a signed-in o8 desktop) presents its Clerk SESSION token as
 * the Bearer. We verify it against the Clerk JWKS (clerk-verify) and trust only
 * the `sub` from the verified token — so a user can only ever fetch their OWN
 * license, and no shared secret is shipped in the app. 503 when CLERK_ISSUER is
 * unset (feature off); 401 on a missing/invalid session.
 *
 * Resolution: an active (non-revoked) subscription wins; else an ACTIVE
 * Founding Operator purchase → a fresh `founder` token + status. When neither
 * clerkUserId lookup hits, the GitHub-identity FALLBACK (#1519): resolve the
 * caller's GitHub external account via the Clerk Backend API and, if a row keys
 * on that githubAccountId, migrate the row's clerkUserId to the caller (one-way)
 * and honor it. 404 only when even that finds nothing. The fallback no-ops
 * entirely when CLERK_SECRET_KEY is unset — the direct lookup is unchanged.
 */
export async function handleAccountLicense(c: Context): Promise<Response> {
  if (!env.CLERK_ISSUER) return c.json({ error: 'account_fetch_not_configured' }, 503);

  const authHeader = c.req.header('authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim() ?? null;
  const clerkUserId = await verifyClerkSession(token);
  if (!clerkUserId) return c.json({ error: 'unauthorized' }, 401);

  // 1) Direct clerkUserId lookup — subscription wins, else active founder.
  const direct =
    (await subscriptionResponse(c, clerkUserId)) ?? (await founderResponse(c, clerkUserId));
  if (direct) return direct;

  // 2) GitHub-identity fallback: the exact clerkUserId no longer matches (dup
  //    Clerk user / instance migration). Resolve the caller's GitHub account and
  //    migrate a matching row's clerkUserId to the caller, then re-run the direct
  //    lookup (now hits). Cached ~10min so a hot loop can't hammer the Clerk API.
  const migration = await resolveAndMigrateByGithub(
    clerkUserId,
    clerkBackend,
    dbIdentityStore,
  ).catch(() => null);
  if (migration) {
    const migrated =
      (await subscriptionResponse(c, clerkUserId)) ?? (await founderResponse(c, clerkUserId));
    if (migrated) return migrated;
  }

  return c.json({ error: 'no_entitlement' }, 404);
}
