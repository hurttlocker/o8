import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema for the o8 license server (Postgres).
 *
 * Two tables:
 *  - `subscriptions`     — one row per Stripe subscription, the source of truth
 *                          for whether a customer is entitled (and to what plan).
 *  - `entitlement_events` — an append-only audit log of everything that
 *                          happened to a subscription (mint, status sync,
 *                          revoke, payment failure).
 */

export const subscriptions = pgTable('subscriptions', {
  /** Internal id (we use the Stripe subscription id as the primary key). */
  id: text('id').primaryKey(),
  stripeCustomerId: text('stripe_customer_id').notNull(),
  stripeSubscriptionId: text('stripe_subscription_id').notNull(),
  /** Clerk user_id carried through Stripe checkout metadata. */
  clerkUserId: text('clerk_user_id'),
  /** Resolved entitlement tier: 'pro' | 'team'. */
  plan: text('plan').notNull(),
  /** Mirrors the Stripe subscription status (active, past_due, canceled, ...). */
  status: text('status').notNull(),
  /** End of the current paid period (when the license should expire absent renewal). */
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  /** Seat count (team plan). Solo Pro is 1. */
  seats: integer('seats').notNull().default(1),
  /** Set when the subscription is canceled/deleted — gates validation. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entitlementEvents = pgTable('entitlement_events', {
  id: text('id').primaryKey(),
  /** FK to subscriptions.id (not enforced at DB level to keep the log durable). */
  subscriptionId: text('subscription_id').notNull(),
  /** Event type: 'license_minted' | 'status_synced' | 'revoked' | 'payment_failed' | ... */
  type: text('type').notNull(),
  /** Arbitrary structured payload for the event (Stripe ids, plan, exp, etc.). */
  payloadJson: jsonb('payload_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Subscription = typeof subscriptions.$inferSelect;
export type NewSubscription = typeof subscriptions.$inferInsert;
export type EntitlementEvent = typeof entitlementEvents.$inferSelect;
export type NewEntitlementEvent = typeof entitlementEvents.$inferInsert;

/**
 * `invites` — beta founding-invite codes registered by the desktop app so they
 * can be redeemed cross-machine (#beta-referral). The desktop generates +
 * displays codes locally; on share it registers the code here, and the
 * o8.run/i/<code> landing resolves + redeems against this table.
 */
export const invites = pgTable('invites', {
  /** The invite code (e.g. '528-191') — the bearer secret + landing slug. */
  code: text('code').primaryKey(),
  /** Inviter display handle (the "via @handle" on the pass). Display-only, not trusted. */
  owner: text('owner').notNull(),
  /** Colorway hex so the landing pass matches the desktop pass. */
  accent: text('accent').notNull(),
  /** Serial position (1..N) for the "No. 0X / 0N" line. */
  position: integer('position').notNull(),
  /** 'sent' on register, 'redeemed' once claimed. */
  status: text('status').notNull().default('sent'),
  /** Invitee email captured at redemption. */
  redeemedBy: text('redeemed_by'),
  redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;

/**
 * `proxy_usage` — one append-only row per managed-inference call routed through
 * the o8 proxy (Step 1). It is the per-account meter (today's spend vs the
 * plan's daily cap) AND the raw COGS ledger we aggregate to set pricing
 * (monetization plan Step 5). Cost is stored as integer MICRO-USD
 * (USD * 1_000_000) so daily sums are exact — no float drift across thousands
 * of sub-cent rows.
 */
export const proxyUsage = pgTable('proxy_usage', {
  id: text('id').primaryKey(),
  /** Account the call is metered against — the plan-token subject (sub claim). */
  sub: text('sub').notNull(),
  /** Plan tier at call time: 'free' | 'pro' | 'team'. */
  plan: text('plan').notNull(),
  /** 'inference' (OpenRouter chat) | 'embeddings' (Gemini). */
  kind: text('kind').notNull(),
  /** Model actually served (OpenRouter's resolved model, or the embed model). */
  model: text('model'),
  /** Exact/estimated cost in micro-USD (USD * 1e6). Inference = OpenRouter's
   *  reported usage.cost; embeddings = a length-based estimate (no cost field). */
  costMicroUsd: integer('cost_micro_usd').notNull().default(0),
  promptTokens: integer('prompt_tokens'),
  completionTokens: integer('completion_tokens'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProxyUsage = typeof proxyUsage.$inferSelect;
export type NewProxyUsage = typeof proxyUsage.$inferInsert;
