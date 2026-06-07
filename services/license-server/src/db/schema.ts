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
