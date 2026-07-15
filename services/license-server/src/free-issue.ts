import { randomUUID } from 'node:crypto';

import type { Context } from 'hono';

import { db } from './db/client.js';
import { productEvents } from './db/schema.js';
import { mintLicense } from './mint.js';
import { BoundedRateLimiter, clientAddress } from './rate-limit.js';

/**
 * POST /issue-free — public first-run issuance of a FREE account token
 * (analytics epic #1249, monetization plan §11: no Stripe in this release; the
 * token is a free credential for proxy-auth + usage attribution).
 *
 * Fresh installs have no credentials, so this is intentionally UNAUTHENTICATED.
 * It mints a free-plan license bound to the install's stable id, so re-issuing
 * for the same install returns the same account (stable `sub`) rather than a new
 * one. Abuse is bounded: the mint itself costs nothing, and a free account's
 * proxy spend is capped per-day server-side. Admission is also bounded per IP,
 * install id, and process so rotating attacker-chosen ids cannot mint without a
 * ceiling. No paid lever is granted (free plan only).
 *
 * Body: { installId: string }. Missing/invalid ids fail closed; silently minting
 * a random identity lets one caller create unlimited independent quota buckets.
 */

const FREE_DAYS = 365;
const HOUR_MS = 60 * 60 * 1000;
const limiter = new BoundedRateLimiter();

/** Accept a client-stable install id (UUID-ish). Reject anything that isn't a
 *  short, plain token so a caller can't smuggle structure into the `sub`. */
function sanitizeInstallId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (s.length < 8 || s.length > 128) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return null;
  return s;
}

export async function handleIssueFree(c: Context): Promise<Response> {
  let body: { installId?: unknown };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    body = {};
  }

  const installId = sanitizeInstallId(body.installId);
  if (!installId) {
    return c.json({ error: 'valid installId required' }, 400);
  }

  const ip = clientAddress(c);
  const allowed = limiter.allow(`free:install:${installId}`, 5, HOUR_MS)
    && limiter.allow(`free:ip:${ip}`, 30, HOUR_MS)
    && limiter.allow('free:global', 10_000, HOUR_MS);
  if (!allowed) {
    c.header('Retry-After', '3600');
    return c.json({ error: 'rate_limited' }, 429);
  }
  const sub = `install:${installId}`;

  const license = await mintLicense({ plan: 'free', sub, days: FREE_DAYS });

  // Count the install in analytics (so a provisioned-but-idle account still
  // shows up, not only ones that have spent). Coarse, no content. Never fail
  // the issuance because the ledger write failed.
  try {
    await db.insert(productEvents).values({
      id: randomUUID(),
      sub,
      plan: 'free',
      event: 'account.provisioned',
      props: null,
    });
  } catch (err) {
    console.error('[free-issue] failed to record provisioning:', err);
  }

  return c.json({ license, plan: 'free', sub });
}
