/**
 * Push subscription store — wraps the SQLite `push_subscriptions` table.
 *
 * Each row is keyed by the browser's PushSubscription endpoint URL.
 * Storing the p256dh + auth keys lets the server encrypt payloads that only
 * that browser can decrypt.
 *
 * Issue: https://github.com/hurttlocker/cortex-ide/issues/639
 */

import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { pushSubscriptions } from '@/lib/db/schema';

export interface StoredPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  label: string | null;
  webhookUrl: string | null;
  lastDeliveredAt: number | null;
  failureCount: number;
}

export interface UpsertPushSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
  label?: string | null;
  webhookUrl?: string | null;
}

const MAX_FAILURE_COUNT = 5;

export function upsertPushSubscription(input: UpsertPushSubscriptionInput): StoredPushSubscription | null {
  const db = getDb();
  if (!db) return null;

  const now = new Date().toISOString();

  // Drizzle's onConflictDoUpdate is awkward when only some columns change;
  // we use a plain INSERT OR REPLACE via raw sql for atomicity.
  db.run(sql`
    INSERT INTO push_subscriptions
      (endpoint, p256dh, auth, user_agent, label, webhook_url, last_delivered_at, failure_count, created_at, updated_at)
    VALUES
      (${input.endpoint}, ${input.p256dh}, ${input.auth},
       ${input.userAgent ?? null}, ${input.label ?? null}, ${input.webhookUrl ?? null},
       NULL, 0, ${now}, ${now})
    ON CONFLICT(endpoint) DO UPDATE SET
      p256dh = excluded.p256dh,
      auth = excluded.auth,
      user_agent = excluded.user_agent,
      label = excluded.label,
      webhook_url = excluded.webhook_url,
      failure_count = 0,
      updated_at = excluded.updated_at
  `);

  return getPushSubscription(input.endpoint);
}

export function getPushSubscription(endpoint: string): StoredPushSubscription | null {
  const db = getDb();
  if (!db) return null;

  const row = db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .get();
  if (!row) return null;

  return {
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.userAgent,
    label: row.label,
    webhookUrl: row.webhookUrl,
    lastDeliveredAt: row.lastDeliveredAt,
    failureCount: row.failureCount,
  };
}

export function listPushSubscriptions(): StoredPushSubscription[] {
  const db = getDb();
  if (!db) return [];

  const rows = db.select().from(pushSubscriptions).all();
  return rows.map((row) => ({
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    userAgent: row.userAgent,
    label: row.label,
    webhookUrl: row.webhookUrl,
    lastDeliveredAt: row.lastDeliveredAt,
    failureCount: row.failureCount,
  }));
}

export function deletePushSubscription(endpoint: string): boolean {
  const db = getDb();
  if (!db) return false;

  const res = db
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.endpoint, endpoint))
    .run() as { changes?: number };
  return (res.changes ?? 0) > 0;
}

export function recordDeliverySuccess(endpoint: string): void {
  const db = getDb();
  if (!db) return;
  db.run(sql`
    UPDATE push_subscriptions
       SET last_delivered_at = ${Date.now()},
           failure_count = 0,
           updated_at = ${new Date().toISOString()}
     WHERE endpoint = ${endpoint}
  `);
}

/**
 * Increment failure_count. Removes the subscription if it exceeds the
 * threshold or if the caller flagged it as permanently gone (HTTP 404/410).
 */
export function recordDeliveryFailure(endpoint: string, options: { permanent?: boolean } = {}): void {
  const db = getDb();
  if (!db) return;

  if (options.permanent) {
    deletePushSubscription(endpoint);
    return;
  }

  const sub = getPushSubscription(endpoint);
  if (!sub) return;
  const nextCount = sub.failureCount + 1;
  if (nextCount >= MAX_FAILURE_COUNT) {
    deletePushSubscription(endpoint);
    return;
  }

  db.run(sql`
    UPDATE push_subscriptions
       SET failure_count = ${nextCount},
           updated_at = ${new Date().toISOString()}
     WHERE endpoint = ${endpoint}
  `);
}
