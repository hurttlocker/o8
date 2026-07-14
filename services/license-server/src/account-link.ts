import type { Context } from 'hono';

import { db } from './db/client.js';
import { installLinks } from './db/schema.js';
import { env } from './env.js';
import { verifyClerkSession } from './clerk-verify.js';
import { clerkBackend } from './clerk-backend.js';

/**
 * POST /account/link-install — associate a pre-sign-in install credential with
 * the signed-in GitHub/Clerk account, so a person's devices + pre-sign-in usage
 * roll up into their ONE profile (beta identity: a user is a GitHub account,
 * installs are their devices).
 *
 * Auth: the desktop presents its Clerk SESSION token (Bearer), verified against
 * the Clerk JWKS. We trust ONLY the `sub` from the verified token, so a user can
 * only ever link an install to their OWN account. Body: { installId } — the raw
 * install id; we store the full `install:<id>` sub to join straight onto the
 * usage ledgers. Idempotent upsert. 503 when Clerk is off, 401 on a bad session,
 * 400 on a missing id. Never throws (telemetry-grade — must not break the app).
 */
export async function handleLinkInstall(c: Context): Promise<Response> {
  if (!env.CLERK_ISSUER) return c.json({ error: 'not_configured' }, 503);

  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? null;
  const clerkUserId = await verifyClerkSession(token);
  if (!clerkUserId) return c.json({ error: 'unauthorized' }, 401);

  let installId = '';
  try {
    const body = (await c.req.json()) as { installId?: unknown };
    installId = typeof body.installId === 'string' ? body.installId.trim().slice(0, 200) : '';
  } catch {
    return c.json({ error: 'bad_request' }, 400);
  }
  if (!installId) return c.json({ error: 'missing_install_id' }, 400);

  // Store the full sub form so it joins straight onto proxy_usage/product_events.
  const installSub = installId.startsWith('install:') ? installId : `install:${installId}`;

  // Best-effort GitHub handle so analytics can label this person. Cached in
  // clerk-backend (~10min); a null just means the row labels on a later link.
  const gh = await clerkBackend.resolveGithubAccount(clerkUserId).catch(() => null);

  try {
    await db
      .insert(installLinks)
      .values({ installSub, clerkUserId, githubLogin: gh?.githubLogin ?? null })
      .onConflictDoUpdate({
        target: installLinks.installSub,
        set: { clerkUserId, ...(gh?.githubLogin ? { githubLogin: gh.githubLogin } : {}) },
      });
  } catch (err) {
    console.error('[link-install] upsert failed:', err);
    return c.json({ ok: false, error: 'record_failed' });
  }
  return c.json({ ok: true });
}
