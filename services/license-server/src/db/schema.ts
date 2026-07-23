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
  /** GitHub external-account id (Clerk's `provider_user_id`) resolved via the
   *  Clerk Backend API — the STABLE identity that survives a duplicate Clerk
   *  user or a Clerk-instance migration. Nullable: backfilled best-effort at
   *  checkout / account-fetch and by the admin backfill; the clerkUserId lookup
   *  is still primary (#1519). */
  githubAccountId: text('github_account_id'),
  /** GitHub login/username at resolution time — debuggability only, never trusted. */
  githubLogin: text('github_login'),
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
  /** The invite code (`o8_` + 128-bit base64url). */
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
 * `founders` — Founding Operator one-time purchases (tiered $150 / $250 / $500,
 * 250-cohort; via Stripe Checkout, mode=payment). Parallel to `subscriptions`
 * but one-off: no renewal, no seats. The Stripe Checkout Session id is the
 * primary key, making the webhook idempotent — Stripe retries the same session
 * id, so we never double-issue an operator number.
 *
 * A founder is granted `plan: 'founder'` — managed inference included for life
 * within the proxy per-account fair-use cap (proxy.ts DAILY_CAP_MICRO_USD). There
 * is NO finite credit block and NO locked rate (dropped per
 * docs/founding-operator-tier.md); `perksJson` holds the derived tier + any
 * future flexible grant data.
 */
export const founders = pgTable('founders', {
  /** Stripe Checkout Session id — PK so webhook retries are idempotent. */
  id: text('id').primaryKey(),
  stripeCustomerId: text('stripe_customer_id'),
  /** Clerk user_id from checkout metadata — the account the license binds to. */
  clerkUserId: text('clerk_user_id'),
  /** GitHub external-account id (Clerk's `provider_user_id`) resolved via the
   *  Clerk Backend API — the STABLE identity used as the read-path fallback when
   *  the clerkUserId no longer matches (duplicate Clerk user / instance
   *  migration). Nullable, best-effort backfilled (#1519). */
  githubAccountId: text('github_account_id'),
  /** GitHub login/username at resolution time — debuggability only, never trusted. */
  githubLogin: text('github_login'),
  /** Buyer email (Stripe customer_details) — welcome mail + contact. */
  email: text('email'),
  /** Serial "Founding Operator #N", assigned at first insert (max+1). Unique. */
  operatorNumber: integer('operator_number').notNull().unique(),
  /** 'active' = granted; 'over_cap' = recorded past the cohort cap, NOT granted;
   *  'revoked'. */
  status: text('status').notNull().default('active'),
  /** Flexible grant bucket — currently { tier, priceUsd }; room for more. */
  perksJson: jsonb('perks_json'),
  licenseMintedAt: timestamp('license_minted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Founder = typeof founders.$inferSelect;
export type NewFounder = typeof founders.$inferInsert;

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

/**
 * `product_events` — coarse, append-only product-usage events (analytics epic
 * #1249, monetization plan §11.2). Distinct from `proxy_usage`, which only sees
 * calls that hit our proxy: this fires on ANY install carrying an account token,
 * so it captures usage even when the work runs on the user's own sub/keys (the
 * common case). It's how we answer "what are people using, and how" beyond raw
 * inference spend.
 *
 * COARSE ONLY — an event name + small structured props (counts / flags /
 * surface ids). NEVER code, repo names, prompts, or file contents (privacy
 * guardrail). Props are size-capped at ingest; oversized payloads are dropped.
 */
export const productEvents = pgTable('product_events', {
  id: text('id').primaryKey(),
  /** Account the event is attributed to — the plan-token subject (sub claim). */
  sub: text('sub').notNull(),
  /** Plan tier at event time: 'free' | 'pro' | 'team'. */
  plan: text('plan').notNull(),
  /** Coarse event name, e.g. 'surface.opened' | 'dispatch.started' | 'brain.asked'. */
  event: text('event').notNull(),
  /** Coarse structured props only (size-capped at ingest). No content. */
  props: jsonb('props'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ProductEvent = typeof productEvents.$inferSelect;
export type NewProductEvent = typeof productEvents.$inferInsert;

/**
 * install_links — maps a pre-sign-in install credential (sub `install:<id>`) to
 * the GitHub/Clerk account that signed in on that machine. Written by
 * POST /account/link-install on desktop sign-in. Lets analytics roll a person's
 * devices + pre-sign-in usage into their ONE account profile (beta identity: a
 * user is a GitHub account, installs are their devices).
 */
export const installLinks = pgTable('install_links', {
  /** The install sub exactly as stored in proxy_usage/product_events: `install:<id>`. */
  installSub: text('install_sub').primaryKey(),
  /** Owning Clerk user id (also the `user_*` sub after sign-in). */
  clerkUserId: text('clerk_user_id').notNull(),
  /** GitHub login at link time (via Clerk) — labels analytics for EVERY
   * signed-in user, not just founders. Display-only, never trusted for auth. */
  githubLogin: text('github_login'),
  linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
});

export type InstallLink = typeof installLinks.$inferSelect;
