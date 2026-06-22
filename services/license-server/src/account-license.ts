import { and, eq, isNull } from 'drizzle-orm';
import type { Context } from 'hono';

import { db } from './db/client.js';
import { founders, subscriptions } from './db/schema.js';
import { env } from './env.js';
import { mintLicense, type Plan } from './mint.js';
import { verifyClerkSession } from './clerk-verify.js';

/**
 * POST /account/license — return THIS signed-in user's license token.
 *
 * Auth: the caller (a signed-in o8 desktop) presents its Clerk SESSION token as
 * the Bearer. We verify it against the Clerk JWKS (clerk-verify) and trust only
 * the `sub` from the verified token — so a user can only ever fetch their OWN
 * license, and no shared secret is shipped in the app. 503 when CLERK_ISSUER is
 * unset (feature off); 401 on a missing/invalid session.
 *
 * Resolution: an active (non-revoked) subscription wins; else an active
 * Founding Operator purchase → a fresh `pro` token + founder metadata. 404 when
 * neither exists.
 */
export async function handleAccountLicense(c: Context): Promise<Response> {
  if (!env.CLERK_ISSUER) return c.json({ error: 'account_fetch_not_configured' }, 503);

  const authHeader = c.req.header('authorization');
  const token = authHeader?.replace(/^Bearer\s+/i, '').trim() ?? null;
  const clerkUserId = await verifyClerkSession(token);
  if (!clerkUserId) return c.json({ error: 'unauthorized' }, 401);

  // 1) Active subscription (non-revoked) — re-mint its plan, tied to the period.
  const subs = await db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.clerkUserId, clerkUserId), isNull(subscriptions.revokedAt)))
    .limit(1);
  if (subs.length > 0) {
    const sub = subs[0]!;
    const days = sub.currentPeriodEnd
      ? Math.max(1, Math.ceil((sub.currentPeriodEnd.getTime() - Date.now()) / 86_400_000))
      : 35;
    const license = await mintLicense({ plan: sub.plan as Plan, sub: clerkUserId, days });
    return c.json({ license, plan: sub.plan, source: 'subscription' });
  }

  // 2) Founding Operator purchase (one-time) — fresh `pro` token + metadata.
  const founderRows = await db
    .select()
    .from(founders)
    .where(and(eq(founders.clerkUserId, clerkUserId), isNull(founders.revokedAt)))
    .limit(1);
  if (founderRows.length > 0) {
    const f = founderRows[0]!;
    const license = await mintLicense({
      plan: 'pro',
      sub: clerkUserId,
      days: Math.max(1, env.FOUNDER_LICENSE_DAYS),
    });
    return c.json({
      license,
      plan: 'pro',
      source: 'founding',
      founder: {
        operatorNumber: f.operatorNumber,
        creditUsd: f.creditMicroUsd / 1_000_000,
        rateLockUsd: f.rateLockMicroUsd != null ? f.rateLockMicroUsd / 1_000_000 : null,
      },
    });
  }

  return c.json({ error: 'no_entitlement' }, 404);
}
