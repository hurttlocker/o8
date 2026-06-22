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
 * Founding Operator one-time purchase ($150). Separate from the subscription
 * checkout path: mode=payment, no subscription object, granted `plan: 'pro'`,
 * recorded in the `founders` table (idempotent on the checkout session id).
 */

/** True when a completed checkout is the one-time Founding Operator purchase
 *  rather than a subscription. The metadata flag o8-site sets is the primary
 *  signal; mode==='payment' + a configured founder price is the fallback. */
export function isFoundingCheckout(session: Stripe.Checkout.Session): boolean {
  if (session.metadata?.productType === 'founding') return true;
  // mode=payment is never a subscription. Only treat a bare one-time checkout
  // as founding when a founder price is configured (so we don't hijack other
  // one-off products that might be added later).
  if (session.mode === 'payment' && env.STRIPE_PRICE_FOUNDER) return true;
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

function rateLockMicroUsd(): number | null {
  if (!env.FOUNDER_RATE_LOCK_USD) return null;
  const usd = Number.parseFloat(env.FOUNDER_RATE_LOCK_USD);
  return Number.isFinite(usd) ? Math.round(usd * 1_000_000) : null;
}

export async function handleFoundingCheckout(
  session: Stripe.Checkout.Session,
): Promise<WebhookResult> {
  const type = 'checkout.session.completed';
  const sessionId = session.id;
  const days = Math.max(1, env.FOUNDER_LICENSE_DAYS);
  const clerkUserId = clerkUserIdFromSession(session);

  // Idempotent: Stripe retries the same session id. If we already recorded this
  // purchase, just re-mint + return — never assign a second operator number.
  const existing = await db.select().from(founders).where(eq(founders.id, sessionId)).limit(1);
  if (existing.length > 0) {
    const row = existing[0]!;
    const license = await mintLicense({ plan: 'pro', sub: row.clerkUserId ?? row.id, days });
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
    if (env.FOUNDER_CAP > 0 && operatorNumber > env.FOUNDER_CAP) {
      console.warn(
        `[founding] operator #${operatorNumber} exceeds FOUNDER_CAP=${env.FOUNDER_CAP} — honoring the paid purchase anyway.`,
      );
    }
    try {
      await db
        .insert(founders)
        .values({
          id: sessionId,
          stripeCustomerId,
          clerkUserId,
          email,
          operatorNumber,
          status: 'active',
          creditMicroUsd: Math.round(Math.max(0, env.FOUNDER_CREDIT_USD) * 1_000_000),
          rateLockMicroUsd: rateLockMicroUsd(),
          perksJson: null,
          licenseMintedAt: new Date(),
          updatedAt: new Date(),
        })
        // Idempotent on the checkout session id (Stripe retries the same id).
        .onConflictDoNothing({ target: founders.id });
      break;
    } catch (err) {
      // A concurrent purchase grabbed this operator_number first — recompute + retry.
      if (attempt >= 4) {
        console.error('[founding] could not assign an operator number after retries:', err);
        throw err;
      }
    }
  }

  // Re-read the authoritative row (an idempotent retry or a concurrent winner
  // set the persisted number); report whatever actually persisted.
  const persisted = (
    await db.select().from(founders).where(eq(founders.id, sessionId)).limit(1)
  )[0];
  const finalNumber = persisted?.operatorNumber ?? 0;

  const license = await mintLicense({ plan: 'pro', sub: clerkUserId ?? sessionId, days });

  try {
    await db.insert(productEvents).values({
      id: randomUUID(),
      sub: clerkUserId ?? `founder:${sessionId}`,
      plan: 'pro',
      event: 'founding.purchased',
      props: { operatorNumber: finalNumber, days },
    });
  } catch (err) {
    console.error('[founding] failed to record purchase event:', err);
  }

  await sendFounderWelcome({ email, operatorNumber: finalNumber, licenseKey: license });

  return { handled: true, type, license };
}
