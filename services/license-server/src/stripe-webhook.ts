import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import Stripe from 'stripe';

import { db } from './db/client.js';
import { entitlementEvents, subscriptions } from './db/schema.js';
import { env } from './env.js';
import { handleFoundingCheckout, isFoundingCheckout } from './founding.js';
import { backfillGithubForRow } from './identity.js';
import { mintLicense, type Plan } from './mint.js';

export const stripe = new Stripe(env.STRIPE_SECRET_KEY);

/** Default license validity (days) when we mint at checkout. */
const DEFAULT_LICENSE_DAYS = 35;

/**
 * Resolve the entitlement plan from a Stripe price id.
 * STRIPE_PRICE_SOLO -> 'pro' ($19/mo solo), STRIPE_PRICE_TEAM -> 'team' ($29/seat).
 */
function planFromPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  if (priceId === env.STRIPE_PRICE_SOLO) return 'pro';
  if (priceId === env.STRIPE_PRICE_TEAM) return 'team';
  return null;
}

/** Append an audit row. Never throws — logging must not break the webhook. */
async function recordEvent(
  subscriptionId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(entitlementEvents).values({
      id: randomUUID(),
      subscriptionId,
      type,
      payloadJson: payload,
    });
  } catch (err) {
    console.error('[license-server] failed to record entitlement_event:', err);
  }
}

/** seconds-epoch -> Date or null. */
function toDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000) : null;
}

/**
 * Read the current-period end from a subscription. The field name shifted to
 * the item level in recent Stripe API versions, so we check both for safety.
 */
function readCurrentPeriodEnd(sub: Stripe.Subscription): number | null {
  const top = (sub as unknown as { current_period_end?: number }).current_period_end;
  if (typeof top === 'number') return top;
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  if (item && typeof item.current_period_end === 'number') return item.current_period_end;
  return null;
}

/** Read the price id from the first subscription item. */
function readPriceId(sub: Stripe.Subscription): string | null {
  return sub.items?.data?.[0]?.price?.id ?? null;
}

/**
 * Verify the raw webhook body against the signing secret and construct the
 * Stripe event. Throws on bad/missing signature — the caller returns 400.
 */
export function constructEvent(rawBody: string | Buffer, signature: string | null): Stripe.Event {
  if (!signature) {
    throw new Error('missing stripe-signature header');
  }
  return stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
}

export interface WebhookResult {
  handled: boolean;
  type: string;
  /** A freshly minted license, when the event produced one (checkout completed). */
  license?: string;
}

/**
 * Handle a VERIFIED Stripe event. We only ever act on the verified event
 * payload — never on client input.
 */
export async function handleStripeEvent(event: Stripe.Event): Promise<WebhookResult> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      // One-time Founding Operator purchase vs a subscription checkout.
      if (isFoundingCheckout(session)) return handleFoundingCheckout(session);
      return handleCheckoutCompleted(session);
    }
    case 'customer.subscription.updated':
      return handleSubscriptionUpdated(event.data.object);
    case 'customer.subscription.deleted':
      return handleSubscriptionDeleted(event.data.object);
    case 'invoice.payment_failed':
      return handlePaymentFailed(event.data.object);
    default:
      return { handled: false, type: event.type };
  }
}

async function handleCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<WebhookResult> {
  const type = 'checkout.session.completed';

  const subscriptionId =
    typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id ?? null;

  if (!subscriptionId) {
    console.warn('[license-server] checkout.session.completed without a subscription — ignoring');
    return { handled: false, type };
  }

  // Fetch the full subscription to resolve plan, period, and seats from the
  // VERIFIED Stripe state (not the thin checkout object).
  const sub = await stripe.subscriptions.retrieve(subscriptionId);

  const plan = planFromPriceId(readPriceId(sub));
  if (!plan) {
    console.warn(
      `[license-server] checkout subscription ${subscriptionId} has an unrecognized price — ` +
        'not in STRIPE_PRICE_SOLO/STRIPE_PRICE_TEAM. Skipping mint.',
    );
    return { handled: false, type };
  }

  const clerkUserId =
    session.metadata?.clerkUserId ??
    session.metadata?.clerk_user_id ??
    sub.metadata?.clerkUserId ??
    null;

  const stripeCustomerId =
    typeof session.customer === 'string'
      ? session.customer
      : session.customer?.id ?? sub.customer.toString();

  const seats = sub.items?.data?.[0]?.quantity ?? 1;
  const periodEnd = readCurrentPeriodEnd(sub);

  // Upsert the subscription row (Stripe subscription id is our primary key).
  await db
    .insert(subscriptions)
    .values({
      id: subscriptionId,
      stripeCustomerId,
      stripeSubscriptionId: subscriptionId,
      clerkUserId,
      plan,
      status: sub.status,
      currentPeriodEnd: toDate(periodEnd),
      seats,
      revokedAt: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: subscriptions.id,
      set: {
        stripeCustomerId,
        clerkUserId,
        plan,
        status: sub.status,
        currentPeriodEnd: toDate(periodEnd),
        seats,
        revokedAt: null,
        updatedAt: new Date(),
      },
    });

  // Best-effort: stamp the STABLE GitHub identity so a duplicate-Clerk-user /
  // instance-migration can still resolve this subscription (#1519). NEVER blocks
  // the payment path — fire-and-forget, self-logging.
  void backfillGithubForRow('subscription', subscriptionId, clerkUserId);

  // Mint the license. Tie validity to the paid period when known, else default.
  const days = periodEnd
    ? Math.max(1, Math.ceil((periodEnd - Date.now() / 1000) / 86400))
    : DEFAULT_LICENSE_DAYS;

  const license = await mintLicense({ plan, sub: clerkUserId ?? subscriptionId, days });

  await recordEvent(subscriptionId, 'license_minted', {
    plan,
    clerkUserId,
    stripeCustomerId,
    seats,
    days,
  });

  return { handled: true, type, license };
}

async function handleSubscriptionUpdated(
  sub: Stripe.Subscription,
): Promise<WebhookResult> {
  const type = 'customer.subscription.updated';
  const subscriptionId = sub.id;

  const existing = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);

  if (existing.length === 0) {
    // We never saw the checkout (e.g. created out-of-band). Record but don't mint.
    console.warn(`[license-server] subscription.updated for unknown ${subscriptionId}`);
    return { handled: false, type };
  }

  const plan = planFromPriceId(readPriceId(sub)) ?? existing[0]!.plan;
  const periodEnd = readCurrentPeriodEnd(sub);

  await db
    .update(subscriptions)
    .set({
      plan,
      status: sub.status,
      currentPeriodEnd: toDate(periodEnd),
      seats: sub.items?.data?.[0]?.quantity ?? existing[0]!.seats,
      updatedAt: new Date(),
    })
    .where(eq(subscriptions.id, subscriptionId));

  await recordEvent(subscriptionId, 'status_synced', { status: sub.status, plan });

  return { handled: true, type };
}

async function handleSubscriptionDeleted(
  sub: Stripe.Subscription,
): Promise<WebhookResult> {
  const type = 'customer.subscription.deleted';
  const subscriptionId = sub.id;

  await db
    .update(subscriptions)
    .set({ status: 'canceled', revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId));

  await recordEvent(subscriptionId, 'revoked', { reason: 'subscription_deleted' });

  return { handled: true, type };
}

async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<WebhookResult> {
  const type = 'invoice.payment_failed';
  const subscriptionId =
    typeof (invoice as unknown as { subscription?: string | { id: string } }).subscription === 'string'
      ? ((invoice as unknown as { subscription: string }).subscription)
      : (invoice as unknown as { subscription?: { id: string } }).subscription?.id ?? null;

  // Grace path: log a warning, do NOT hard-revoke. The license stays valid; the
  // desktop verifier's offline-grace window covers the dunning period. A revoke
  // only happens on customer.subscription.deleted.
  console.warn(
    `[license-server] payment failed for subscription ${subscriptionId ?? 'unknown'} — ` +
      'grace, no revoke.',
  );

  if (subscriptionId) {
    await recordEvent(subscriptionId, 'payment_failed', {
      invoiceId: invoice.id ?? null,
      note: 'grace — no revoke',
    });
  }

  return { handled: true, type };
}
