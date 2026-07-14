import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { serve } from '@hono/node-server';
import { count, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from './db/client.js';
import { runStartupMigrations } from './db/migrate.js';
import { entitlementEvents, founders, subscriptions } from './db/schema.js';
import { env } from './env.js';
import { mintLicense, type Plan } from './mint.js';
import { constructEvent, handleStripeEvent } from './stripe-webhook.js';
import { validateEntitlement } from './validate.js';
import { redeemInvite, registerInvite, resolveInvite } from './invites.js';
import { handleEmbeddings, handleGeminiGenerate, handleInference, handleTranscribe } from './proxy.js';
import { handleAnalytics, handleSiteEvent, handleTelemetry } from './analytics.js';
import { handleIssueFree } from './free-issue.js';
import { handleAccountLicense } from './account-license.js';
import { handleGithubAppToken } from './github-app.js';
import { handleLinkInstall } from './account-link.js';
import { runGithubBackfill } from './identity.js';

const app = new Hono();

const VALID_PLANS: readonly Plan[] = ['free', 'pro', 'team', 'founder'];

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

/** Constant-time guard for the invite-registration token — scoped separately
 *  from ADMIN_TOKEN (the desktop ships this, so a leak can only register
 *  invites, never mint/revoke licenses). Disabled when the token is unset. */
function isInviteRegistrar(authHeader: string | undefined): boolean {
  if (!env.INVITE_REGISTER_TOKEN) return false;
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token.length === 0) return false;
  const provided = createHash('sha256').update(token).digest();
  const expected = createHash('sha256').update(env.INVITE_REGISTER_TOKEN).digest();
  return timingSafeEqual(provided, expected);
}

/** Constant-time guard for the analytics dashboard — a READ-ONLY token scoped
 *  separately from ADMIN_TOKEN, so the credential the founder's desktop holds
 *  can only read aggregate stats, never mint/revoke. Full admins also pass.
 *  When ANALYTICS_TOKEN is unset, only the full ADMIN_TOKEN is accepted. */
function isAnalyticsReader(authHeader: string | undefined): boolean {
  if (isAdmin(authHeader)) return true;
  if (!env.ANALYTICS_TOKEN) return false;
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token.length === 0) return false;
  const provided = createHash('sha256').update(token).digest();
  const expected = createHash('sha256').update(env.ANALYTICS_TOKEN).digest();
  return timingSafeEqual(provided, expected);
}

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (c) => c.json({ ok: true, service: 'o8-license-server', issuer: env.ISSUER }));

// ── Founding cohort count (PUBLIC, read-only) ─────────────────────────────────
// The number of GRANTED founders (status='active' — NOT 'over_cap'/'revoked').
// The NEXT buyer's position is count+1. o8.run proxies this server-side
// (app/api/founding/*) to resolve the tier + price, so no secret/auth is needed
// and no PII is exposed. On a DB error we surface 503 so o8-site fails CLOSED
// (refuses to guess a price) rather than mis-pricing a seat.
app.get('/v1/founders/count', async (c) => {
  try {
    const rows = await db
      .select({ n: count() })
      .from(founders)
      .where(eq(founders.status, 'active'));
    return c.json({ count: rows[0]?.n ?? 0 });
  } catch (err) {
    console.error('[license-server] /v1/founders/count failed:', err);
    return c.json({ error: 'count_unavailable' }, 503);
  }
});

// Public list for the founders wall (o8-site /founders). Returns active founders
// as { position, displayName } — the client computes tier from position and falls
// back to "Founding Operator" when displayName is null. displayName is read from
// perks_json.displayName (set only when a founder opts in / is seeded), so the wall
// stays privacy-safe (never exposes email) until a name-capture flow is added.
app.get('/v1/founders', async (c) => {
  try {
    const rows = await db
      .select({ operatorNumber: founders.operatorNumber, perks: founders.perksJson })
      .from(founders)
      .where(eq(founders.status, 'active'));
    const list = rows.map((r) => {
      const perks = r.perks as { displayName?: unknown } | null;
      const displayName =
        perks && typeof perks.displayName === 'string' ? perks.displayName : null;
      return { position: r.operatorNumber, displayName };
    });
    return c.json({ founders: list });
  } catch (err) {
    console.error('[license-server] /v1/founders failed:', err);
    return c.json({ error: 'founders_unavailable' }, 503);
  }
});

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

// ── Managed-inference proxy (Step 1) — plan-token auth + per-account cap ──────
app.post('/v1/inference', handleInference);
app.post('/v1/embeddings', handleEmbeddings);
app.post('/v1/gemini', handleGeminiGenerate);
app.post('/v1/transcribe', handleTranscribe);

// ── Telemetry ingest (analytics epic #1249) — plan-token auth, coarse events ──
app.post('/v1/telemetry', handleTelemetry);

// ── First-run free issuance (epic #1249) — PUBLIC: fresh installs have no creds.
//    Mints a free-plan token bound to the install id (stable account `sub`). ──
app.post('/issue-free', handleIssueFree);

// ── Account-keyed license fetch — a signed-in desktop pulls its OWN license
//    (Founding Operator or active subscription). Auth = the caller's Clerk
//    session token, verified server-side via JWKS; NO shared secret shipped in
//    the app. 503 until CLERK_ISSUER is configured. ─────────────────────────
app.post('/account/license', handleAccountLicense);
app.post('/account/link-install', handleLinkInstall);

// ── Managed GitHub App token mint — the desktop asks for a short-lived
//    installation token for the PUBLIC "o8" GitHub App. Same Clerk-session
//    auth as /account/license; the App private key lives only here. ─────────
app.post('/github/app/token', handleGithubAppToken);

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

// ── Usage analytics — founder dashboard data (epic #1249). Read-only token
//    (ANALYTICS_TOKEN) OR full admin; never mint/revoke scope. ───────────────
app.get('/admin/analytics', async (c) => {
  if (!isAnalyticsReader(c.req.header('authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return handleAnalytics(c);
});

// Site-event ingest (o8.run server-to-server, e.g. download clicks). Same
// analytics-token guard: the handler whitelists event names, so this token
// still can't write anything beyond coarse site counters.
app.post('/admin/site-event', async (c) => {
  if (!isAnalyticsReader(c.req.header('authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return handleSiteEvent(c);
});

// ── GitHub-identity backfill (#1519) — ADMIN-guarded (write scope). Walks
//    founders + subscriptions rows that have a clerkUserId but no
//    github_account_id yet and populates it via the Clerk Backend API.
//    Idempotent (only touches null rows). `{ dryRun: true }` resolves + counts
//    without writing. 503 when CLERK_SECRET_KEY is unset. ───────────────────
app.post('/admin/backfill-github', async (c) => {
  if (!isAdmin(c.req.header('authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  if (!env.CLERK_SECRET_KEY) {
    return c.json({ error: 'clerk_backend_not_configured' }, 503);
  }
  let body: { dryRun?: unknown; limit?: unknown } = {};
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    /* empty/invalid body → defaults (dryRun off) */
  }
  const dryRun = body.dryRun === true;
  const limit = typeof body.limit === 'number' && body.limit > 0 ? body.limit : undefined;
  const summary = await runGithubBackfill({ dryRun, limit });
  console.log('[identity] backfill-github summary:', JSON.stringify(summary));
  return c.json(summary);
});

// ── Beta invites (#beta-referral) ─────────────────────────────────────────────

// Register a shared code so it's redeemable cross-machine. Scoped-token guarded
// (the desktop sends INVITE_REGISTER_TOKEN). 503 when registration isn't configured.
app.post('/invites/register', async (c) => {
  if (!env.INVITE_REGISTER_TOKEN) return c.json({ error: 'registration_not_configured' }, 503);
  if (!isInviteRegistrar(c.req.header('authorization'))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: { code?: unknown; owner?: unknown; accent?: unknown; position?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const owner = typeof body.owner === 'string' ? body.owner.trim() : '';
  const accent = typeof body.accent === 'string' ? body.accent.trim() : '#FF5A1F';
  const position = typeof body.position === 'number' ? body.position : 0;
  if (!code || !owner) return c.json({ error: 'code and owner required' }, 400);

  const result = await registerInvite({ code, owner, accent, position });
  if (!result.ok) return c.json({ ok: false, reason: result.reason }, result.reason === 'code_taken' ? 409 : 400);
  return c.json({ ok: true });
});

// Resolve a code for the landing (public — no secrets, just owner + colorway + status).
app.get('/invites/:code', async (c) => {
  const result = await resolveInvite(c.req.param('code'));
  return c.json(result, result.valid ? 200 : 404);
});

// Redeem a code (public, one-time). Captures the invitee email.
app.post('/invites/redeem', async (c) => {
  let body: { code?: unknown; email?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ ok: false, reason: 'invalid JSON body' }, 400);
  }

  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!code || !email) return c.json({ ok: false, reason: 'code and email required' }, 400);

  const result = await redeemInvite(code, email);
  if (!result.ok) {
    const status = result.reason === 'already_redeemed' ? 409 : result.reason === 'not_found' ? 404 : 400;
    return c.json({ ok: false, reason: result.reason, owner: result.owner ?? null }, status);
  }
  return c.json({ ok: true, owner: result.owner ?? null });
});

// Self-migrate before accepting traffic — Railway never runs drizzle-kit push,
// so additive columns (install_links.github_login) must be applied here or the
// first request that touches them 500s (audit #3). Non-fatal on failure.
void runStartupMigrations().catch((err) => {
  console.error('[license-server] startup migration error:', err instanceof Error ? err.message : err);
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[license-server] listening on :${info.port} (issuer=${env.ISSUER})`);
});

export { app };
