import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { serve } from '@hono/node-server';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from './db/client.js';
import { entitlementEvents, subscriptions } from './db/schema.js';
import { env } from './env.js';
import { mintLicense, type Plan } from './mint.js';
import { constructEvent, handleStripeEvent } from './stripe-webhook.js';
import { validateEntitlement } from './validate.js';

const app = new Hono();

const VALID_PLANS: readonly Plan[] = ['free', 'pro', 'team'];

/** Constant-time admin guard. Returns true when the bearer matches. */
function isAdmin(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token.length === 0) return false;
  // SHA-256 both sides to fixed-length buffers, then compare in constant time —
  // avoids the early-exit timing leak of === and the length leak of a length check.
  const provided = createHash('sha256').update(token).digest();
  const expected = createHash('sha256').update(env.ADMIN_TOKEN).digest();
  return timingSafeEqual(provided, expected);
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (c) => c.json({ ok: true, service: 'o8-license-server', issuer: env.ISSUER }));

// ── Stripe webhook (RAW body required for signature verification) ─────────────
app.post('/webhooks/stripe', async (c) => {
  const signature = c.req.header('stripe-signature') ?? null;
  // c.req.text() returns the unparsed body — DO NOT json()-parse first, or the
  // signature check fails (Stripe signs the exact raw bytes).
  const rawBody = await c.req.text();

  let event;
  try {
    event = constructEvent(rawBody, signature);
  } catch (err) {
    console.warn('[license-server] webhook signature verification failed:', (err as Error).message);
    return c.json({ error: 'invalid signature' }, 400);
  }

  try {
    const result = await handleStripeEvent(event);
    // Never return the minted license to Stripe — just acknowledge receipt.
    return c.json({ received: true, handled: result.handled, type: result.type });
  } catch (err) {
    console.error('[license-server] error handling webhook:', err);
    // Return 200 so Stripe does not retry a poison event indefinitely; the
    // error is logged for investigation.
    return c.json({ received: true, handled: false, error: 'internal' }, 200);
  }
});

// ── Validate an entitlement token ─────────────────────────────────────────────
app.post('/validate-entitlement', async (c) => {
  let body: { token?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ valid: false, reason: 'invalid JSON body' }, 400);
  }
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return c.json({ valid: false, reason: 'missing token' }, 400);

  const result = await validateEntitlement(token);
  return c.json(result);
});

// ── Manual issuance (ADMIN-guarded) — for testing before live Stripe ──────────
app.post('/issue-entitlement', async (c) => {
  if (!isAdmin(c.req.header('authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: { plan?: unknown; sub?: unknown; days?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const plan = body.plan;
  if (typeof plan !== 'string' || !(VALID_PLANS as readonly string[]).includes(plan)) {
    return c.json({ error: 'plan must be one of free|pro|team' }, 400);
  }
  const sub = typeof body.sub === 'string' ? body.sub : undefined;
  const days = typeof body.days === 'number' && body.days > 0 ? body.days : 35;

  const license = await mintLicense({ plan: plan as Plan, sub, days });
  return c.json({ license, plan, sub: sub ?? null, days });
});

// ── Revoke a subscription (ADMIN-guarded) ─────────────────────────────────────
app.delete('/revoke/:subscriptionId', async (c) => {
  if (!isAdmin(c.req.header('authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  const subscriptionId = c.req.param('subscriptionId');
  if (!subscriptionId) return c.json({ error: 'missing subscriptionId' }, 400);

  const updated = await db
    .update(subscriptions)
    .set({ status: 'canceled', revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(subscriptions.id, subscriptionId))
    .returning({ id: subscriptions.id });

  if (updated.length === 0) {
    return c.json({ error: 'subscription not found' }, 404);
  }

  await db.insert(entitlementEvents).values({
    id: randomUUID(),
    subscriptionId,
    type: 'revoked',
    payloadJson: { reason: 'manual_admin_revoke' },
  });

  return c.json({ revoked: true, subscriptionId });
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[license-server] listening on :${info.port} (issuer=${env.ISSUER})`);
});

export { app };
