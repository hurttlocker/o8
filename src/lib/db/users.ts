/**
 * User Data Access Layer
 *
 * Typed CRUD operations for the users table.
 * All mutations return the updated record.
 */

import { eq } from 'drizzle-orm';
import { getDb, users, subscriptions, apiKeys } from './index';
import { randomUUID } from 'node:crypto';

// ── Types ──

export type Plan = 'free' | 'pro' | 'team';

export interface CreateUserInput {
  githubId?: number;
  discordId?: string;
  clerkUserId?: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  plan?: Plan;
}

export interface UserProfile {
  id: string;
  githubId: number | null;
  discordId: string | null;
  clerkUserId: string | null;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
  plan: Plan;
  tokenBudgetUsd: number | null;
  createdAt: string;
  subscription: {
    status: string;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean | null;
  } | null;
  hasApiKeys: {
    anthropic: boolean;
    openai: boolean;
    google: boolean;
  };
}

// ── Plan budget defaults ──

const PLAN_BUDGETS: Record<Plan, number | null> = {
  free: null,    // BYOK only, no managed budget
  pro: 40,       // $40/mo included tokens
  team: 200,     // $200/mo pooled team budget
};

// ── CRUD ──

/**
 * Create a new user. Returns the created user.
 */
export function createUser(input: CreateUserInput) {
  const db = getDb()!;
  const id = randomUUID();
  const plan = input.plan ?? 'free';

  db.insert(users).values({
    id,
    githubId: input.githubId ?? null,
    discordId: input.discordId ?? null,
    clerkUserId: input.clerkUserId ?? null,
    email: input.email ?? null,
    name: input.name ?? null,
    avatarUrl: input.avatarUrl ?? null,
    plan,
    tokenBudgetUsd: PLAN_BUDGETS[plan],
  }).run();

  return db.select().from(users).where(eq(users.id, id)).get()!;
}

/**
 * Find user by ID.
 */
export function findUserById(id: string) {
  return getDb()!.select().from(users).where(eq(users.id, id)).get() ?? null;
}

/**
 * Find user by GitHub ID. Used during OAuth callback.
 */
export function findUserByGithubId(githubId: number) {
  return getDb()!.select().from(users).where(eq(users.githubId, githubId)).get() ?? null;
}

/**
 * Find user by Discord ID.
 */
export function findUserByDiscordId(discordId: string) {
  return getDb()!.select().from(users).where(eq(users.discordId, discordId)).get() ?? null;
}

/**
 * Find user by Clerk user ID. Used during Clerk session resolution.
 */
export function findUserByClerkId(clerkUserId: string) {
  return getDb()!.select().from(users).where(eq(users.clerkUserId, clerkUserId)).get() ?? null;
}

/**
 * Find user by email.
 */
export function findUserByEmail(email: string) {
  return getDb()!.select().from(users).where(eq(users.email, email)).get() ?? null;
}

/**
 * Find or create user by GitHub ID (upsert pattern for OAuth).
 */
export function findOrCreateByGithub(githubId: number, profile: { email?: string; name?: string; avatarUrl?: string }) {
  const existing = findUserByGithubId(githubId);
  if (existing) {
    // Update profile on each login
    updateUser(existing.id, {
      name: profile.name ?? existing.name,
      avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
      email: profile.email ?? existing.email,
      lastLoginAt: new Date().toISOString(),
    });
    return findUserById(existing.id)!;
  }
  return createUser({ githubId, ...profile });
}

/**
 * Find or create a user from a Clerk session (upsert pattern for Clerk sign-in).
 *
 * Resolution order avoids duplicating users that already exist from the legacy
 * GitHub device flow:
 *   1. Match on clerkUserId — returning user, refresh profile.
 *   2. Else match on githubId (Clerk signs in via GitHub) — link the existing
 *      row to this Clerk id rather than creating a second account.
 *   3. Else create a fresh user keyed by clerkUserId.
 */
export function findOrCreateByClerk(
  clerkUserId: string,
  profile: { githubId?: number; email?: string; name?: string; avatarUrl?: string } = {},
) {
  const now = new Date().toISOString();

  // 1. Known Clerk user — refresh profile on each login.
  const existing = findUserByClerkId(clerkUserId);
  if (existing) {
    updateUser(existing.id, {
      name: profile.name ?? existing.name,
      avatarUrl: profile.avatarUrl ?? existing.avatarUrl,
      email: profile.email ?? existing.email,
      lastLoginAt: now,
    });
    return findUserById(existing.id)!;
  }

  // 2. Existing GitHub user (legacy device flow) — link to this Clerk id
  //    instead of creating a duplicate account.
  if (profile.githubId != null) {
    const byGithub = findUserByGithubId(profile.githubId);
    if (byGithub) {
      updateUser(byGithub.id, {
        clerkUserId,
        name: profile.name ?? byGithub.name,
        avatarUrl: profile.avatarUrl ?? byGithub.avatarUrl,
        email: profile.email ?? byGithub.email,
        lastLoginAt: now,
      });
      return findUserById(byGithub.id)!;
    }
  }

  // 3. Brand-new user.
  const created = createUser({ clerkUserId, ...profile });
  updateUser(created.id, { lastLoginAt: now });
  return findUserById(created.id)!;
}

/**
 * Update user fields. Only updates provided fields.
 */
export function updateUser(id: string, fields: Partial<{
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  clerkUserId: string | null;
  plan: Plan;
  tokenBudgetUsd: number | null;
  lastLoginAt: string | null;
}>) {
  const db = getDb()!;
  const updates: Record<string, unknown> = { ...fields, updatedAt: new Date().toISOString() };

  // If plan changed, update budget
  if (fields.plan && !fields.tokenBudgetUsd) {
    updates.tokenBudgetUsd = PLAN_BUDGETS[fields.plan];
  }

  db.update(users).set(updates).where(eq(users.id, id)).run();
  return findUserById(id);
}

/**
 * Get full user profile with subscription + API key status.
 */
export function getUserProfile(id: string): UserProfile | null {
  const db = getDb()!;
  const user = findUserById(id);
  if (!user) return null;

  // Get subscription
  const sub = db.select().from(subscriptions).where(eq(subscriptions.userId, id)).get();

  // Check which providers have BYOK keys
  const keys = db.select().from(apiKeys).where(eq(apiKeys.userId, id)).all();
  const keyProviders = new Set(keys.filter(k => k.isActive).map(k => k.provider));

  return {
    id: user.id,
    githubId: user.githubId,
    discordId: user.discordId,
    clerkUserId: user.clerkUserId,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    plan: user.plan as Plan,
    tokenBudgetUsd: user.tokenBudgetUsd,
    createdAt: user.createdAt,
    subscription: sub ? {
      status: sub.status,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    } : null,
    hasApiKeys: {
      anthropic: keyProviders.has('anthropic'),
      openai: keyProviders.has('openai'),
      google: keyProviders.has('google'),
    },
  };
}

/**
 * Delete a user and all associated data (cascades).
 */
export function deleteUser(id: string): boolean {
  const result = getDb()!.delete(users).where(eq(users.id, id)).run();
  return result.changes > 0;
}

/**
 * Count total users (for admin/analytics).
 */
export function countUsers(): number {
  const result = getDb()!.select().from(users).all();
  return result.length;
}
