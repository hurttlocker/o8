/**
 * Database Schema — Foundation for Monetization
 *
 * SQLite for local/dev, designed to map cleanly to PostgreSQL for production.
 * All monetization features (auth, billing, usage, teams) depend on these tables.
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/217
 */

import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ══════════════════════════════════════════════════════════════════
//  Users — core identity
// ══════════════════════════════════════════════════════════════════

export const users = sqliteTable('users', {
  /** UUID primary key */
  id: text('id').primaryKey(),
  /** GitHub user ID (unique, nullable for email-only users) */
  githubId: integer('github_id').unique(),
  /** Discord user ID (unique, nullable) */
  discordId: text('discord_id').unique(),
  /** Email address */
  email: text('email').unique(),
  /** Display name */
  name: text('name'),
  /** Avatar URL (from GitHub/Discord) */
  avatarUrl: text('avatar_url'),
  /** Plan tier: free | pro | team */
  plan: text('plan', { enum: ['free', 'pro', 'team'] }).notNull().default('free'),
  /** Monthly token budget in USD (null = unlimited for BYOK) */
  tokenBudgetUsd: real('token_budget_usd'),
  /** Created timestamp (ISO 8601) */
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  /** Last updated timestamp */
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  /** Last login timestamp */
  lastLoginAt: text('last_login_at'),
});

// ══════════════════════════════════════════════════════════════════
//  API Keys — BYOK storage (encrypted at rest)
// ══════════════════════════════════════════════════════════════════

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** LLM provider: anthropic | openai | google */
  provider: text('provider', { enum: ['anthropic', 'openai', 'google'] }).notNull(),
  /** Encrypted API key (AES-256-GCM, key from env) */
  encryptedKey: text('encrypted_key').notNull(),
  /** IV for decryption */
  iv: text('iv').notNull(),
  /** Label (user-friendly name, e.g. "Work key") */
  label: text('label'),
  /** Is this the active key for this provider? */
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Usage Logs — token metering per request
// ══════════════════════════════════════════════════════════════════

export const usageLogs = sqliteTable('usage_logs', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Model used (e.g. claude-opus-4-6, gpt-5.4) */
  model: text('model').notNull(),
  /** LLM provider */
  provider: text('provider', { enum: ['anthropic', 'openai', 'google'] }).notNull(),
  /** Input tokens consumed */
  inputTokens: integer('input_tokens').notNull().default(0),
  /** Output tokens consumed */
  outputTokens: integer('output_tokens').notNull().default(0),
  /** Cache read tokens (Anthropic) */
  cacheReadTokens: integer('cache_read_tokens').default(0),
  /** Cache write tokens (Anthropic) */
  cacheWriteTokens: integer('cache_write_tokens').default(0),
  /** Computed cost in USD */
  costUsd: real('cost_usd').notNull().default(0),
  /** Associated agent session key */
  sessionKey: text('session_key'),
  /** Agent name (for breakdown) */
  agentName: text('agent_name'),
  /** Request type: chat | completion | embedding */
  requestType: text('request_type', { enum: ['chat', 'completion', 'embedding'] }).default('chat'),
  /** Billing period (YYYY-MM for monthly rollups) */
  billingPeriod: text('billing_period').notNull(),
  /** Timestamp */
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Subscriptions — Stripe billing link
// ══════════════════════════════════════════════════════════════════

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }).unique(),
  /** Stripe customer ID */
  stripeCustomerId: text('stripe_customer_id').unique(),
  /** Stripe subscription ID */
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  /** Plan at Stripe level */
  plan: text('plan', { enum: ['free', 'pro', 'team'] }).notNull().default('free'),
  /** Subscription status */
  status: text('status', { enum: ['active', 'canceled', 'past_due', 'trialing', 'incomplete'] }).notNull().default('active'),
  /** Current period end (ISO 8601) */
  currentPeriodEnd: text('current_period_end'),
  /** Whether subscription auto-cancels at period end */
  cancelAtPeriodEnd: integer('cancel_at_period_end', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Sessions — auth sessions (JWT tracking)
// ══════════════════════════════════════════════════════════════════

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Hashed refresh token */
  tokenHash: text('token_hash').notNull(),
  /** User agent string */
  userAgent: text('user_agent'),
  /** IP address */
  ipAddress: text('ip_address'),
  /** Expires at (ISO 8601) */
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Teams — multi-user organizations
// ══════════════════════════════════════════════════════════════════

export const teams = sqliteTable('teams', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Owner user ID */
  ownerId: text('owner_id').notNull().references(() => users.id),
  /** Slug for URL (team identifier) */
  slug: text('slug').unique(),
  /** Pooled token budget in USD per month */
  tokenBudgetUsd: real('token_budget_usd'),
  /** Max seats */
  maxSeats: integer('max_seats').default(10),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

export const teamMembers = sqliteTable('team_members', {
  id: text('id').primaryKey(),
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  /** Member role */
  role: text('role', { enum: ['owner', 'admin', 'member', 'readonly'] }).notNull().default('member'),
  joinedAt: text('joined_at').notNull().default(sql`(datetime('now'))`),
});

// ══════════════════════════════════════════════════════════════════
//  Waitlist — pre-launch signups
// ══════════════════════════════════════════════════════════════════

export const waitlist = sqliteTable('waitlist', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  githubUsername: text('github_username'),
  source: text('source'), // where they heard about us
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});
