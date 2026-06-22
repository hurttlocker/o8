import { randomUUID } from 'node:crypto';

import { desc, eq } from 'drizzle-orm';
import type Stripe from 'stripe';

import { db } from './db/client.js';
import { founders, productEvents } from './db/schema.js';
import { sendFounderWelcome } from './email.js';
import { env } from './env.js';
import { mintLicense } from './mint.js';
import type { WebhookResult } from './stripe-webhook.js';

/**
 * Founding Operator one-time purchase (tiered $150 / $250 / $500, 250-cohort).
 * Separate from the subscription checkout path: mode=payment, no subscription
 * object, granted `plan: 'founder'` (managed inference included for life within
 * the proxy per-account fair-use cap — proxy.ts DAILY_CAP_MICRO_USD.founder).
 * Recorded in the `founders` table (idempotent on the checkout session id).
 *
 * The cohort cap is a HARD ceiling: a checkout beyond FOUNDER_CAP is recorded
 * as `status: 'over_cap'` and NOT granted founder status (needs a manual
 * refund/honor decision) — we never silently exceed the cohort, and never drop
 * the record of a paid purchase.
 */

/** Founder pricing tier, derived from the assigned operator number (spec
 *  docs/founding-operator-tier.md): T1 #1-100 $150, T2 #101-200 $250,
 *  T3 #201-250 $500. */
export function founderTier(operatorNumber: number): { tier: 1 | 2 | 3; priceUsd: number } {
  if (operatorNumber <= 100) return { tier: 1, priceUsd: 150 };
  if (operatorNumber <= 200) return { tier: 2, priceUsd: 250 };
  return { tier: 3, priceUsd: 500 };
}

function anyFounderPriceConfigured(): boolean {
  return Boolean(
    env.STRIPE_PRICE_FOUNDER_T1 || env.STRIPE_PRICE_FOUNDER_T2 || env.STRIPE_PRICE_FOUNDER_T3,
  );
}

/** True when a completed checkout is the one-time Founding Operator purchase
 *  rather than a subscription. The metadata flag o8-site sets is the primary
 *  signal; mode==='payment' + a configured founder price is the fallback.
 *  o8-site's checkout (app/api/founding/checkout) stamps `metadata.product`,
 *  while older drafts used `metadata.productType` — accept either so the
 *  explicit signal fires regardless of which the checkout writes. */
export function isFoundingCheckout(session: Stripe.Checkout.Session): boolean {
  if (session.metadata?.productType === 'founding') return true;
  if (session.metadata?.product === 'founding') return true;
  if (session.mode === 'payment' && anyFounderPriceConfigured()) return true;
  return false;
}

function emailFromSession(session: Stripe.Checkout.Session): string | null {
  return (
    session.customer_details?.email ??
    (session as unknown as { customer_email?: string | null }).customer_email ??
    null
  );
}

function clerkUserIdFromSession(session: Stripe.Checkout.Session): string | null {
  return session.metadata?.clerkUserId ?? session.metadata?.clerk_user_id ?? null;
}

async function nextOperatorNumber(): Promise<number> {
  const top = await db
    .select({ n: founders.operatorNumber })
    .from(founders)
    .orderBy(desc(founders.operatorNumber))
    .limit(1);
  return (top[0]?.n ?? 0) + 1;
}

export async function handleFoundingCheckout(
  session: Stripe.Checkout.Session,
): Promise<WebhookResult> {
  const type = 'checkout.session.completed';
  const sessionId = session.id;
  const days = Math.max(1, env.FOUNDER_LICENSE_DAYS);
  const clerkUserId = clerkUserIdFromSession(session);

  // Idempotent: Stripe retries the same session id. Re-mint only for an ACTIVE
  // founder; an over_cap / revoked row is recorded but never granted a token.
  const existing = await db.select().from(founders).where(eq(founders.id, sessionId)).limit(1);
  if (existing.length > 0) {
    const row = existing[0]!;
    if (row.status !== 'active') return { handled: true, type };
    const license = await mintLicense({ plan: 'founder', sub: row.clerkUserId ?? row.id, days });
    return { handled: true, type, license };
  }

  const stripeCustomerId =
    typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null);
  const email = emailFromSession(session);

  // Assign the next operator number and insert. Retry on the rare
  // operator_number unique collision from a CONCURRENT purchase — founders are
  // low-volume, but a paid checkout must never fail to record.
  for (let attempt = 0; ; attempt++) {
    const operatorNumber = await nextOperatorNumber();
    const withinCap = env.FOUNDER_CAP <= 0 || operatorNumber <= env.FOUNDER_CAP;
    try {
      await db
        .insert(founders)
        .values({
          id: sessionId,
          stripeCustomerId,
          clerkUserId,
          email,
          operatorNumber,
          // HARD ceiling: past the cohort cap we record the purchase but do NOT
          // grant founder status (manual refund/honor decision downstream).
          status: withinCap ? 'active' : 'over_cap',
          perksJson: withinCap ? founderTier(operatorNumber) : null,
          licenseMintedAt: withinCap ? new Date() : null,
          updatedAt: new Date(),
        })
        .onConflictDoNothing({ target: founders.id });
      break;
    } catch (err) {
      if (attempt >= 4) {
        console.error('[founding] could not assign an operator number after retries:', err);
        throw err;
      }
    }
  }

  // Re-read the authoritative row (an idempotent retry or a concurrent winner
  // set the persisted number/status); act on what actually persisted.
  const persisted = (
    await db.select().from(founders).where(eq(founders.id, sessionId)).limit(1)
  )[0];
  const finalNumber = persisted?.operatorNumber ?? 0;

  // Cohort full → recorded as over_cap, no founder token. Flag loudly so the
  // operator can refund or manually honor it.
  if (!persisted || persisted.status !== 'active') {
    console.warn(
      `[founding] cohort cap (${env.FOUNDER_CAP}) reached — purchase ${sessionId} recorded as over_cap at #${finalNumber}; NOT granted. Manual refund/honor needed.`,
    );
    return { handled: true, type };
  }

  const { tier } = founderTier(finalNumber);
  const license = await mintLicense({ plan: 'founder', sub: clerkUserId ?? sessionId, days });

  try {
    await db.insert(productEvents).values({
      id: randomUUID(),
      sub: clerkUserId ?? `founder:${sessionId}`,
      plan: 'founder',
      event: 'founding.purchased',
      props: { operatorNumber: finalNumber, tier, days },
    });
  } catch (err) {
    console.error('[founding] failed to record purchase event:', err);
  }

  await sendFounderWelcome({ email, operatorNumber: finalNumber, licenseKey: license });

  return { handled: true, type, license };
}
