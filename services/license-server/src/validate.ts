import { createPublicKey } from 'node:crypto';

import { importSPKI, jwtVerify, errors as joseErrors } from 'jose';

import { db } from './db/client.js';
import { subscriptions } from './db/schema.js';
import { env } from './env.js';
import type { Plan } from './mint.js';
import { eq } from 'drizzle-orm';

const VALID_PLANS: readonly Plan[] = ['free', 'pro', 'team'];
const DEFAULT_GRACE_DAYS = 30;

/**
 * Derive the SPKI PUBLIC key PEM from the configured Ed25519 PRIVATE key.
 *
 * The server verifies tokens with the SAME method the desktop uses
 * (importSPKI + jwtVerify, alg EdDSA), so a server-side `/validate-entitlement`
 * is a faithful mirror of the M4 desktop check, plus a revocation lookup.
 */
const publicKeyPem: string = createPublicKey({
  key: env.LICENSE_PRIVATE_KEY,
  format: 'pem',
})
  .export({ type: 'spki', format: 'pem' })
  .toString();

export interface ValidationResult {
  valid: boolean;
  plan: Plan | null;
  expiresAt: number | null;
  revoked: boolean;
  graceDaysLeft: number | null;
  /** Token subject (account id) — used by the proxy to meter per account. */
  sub: string | null;
  reason?: string;
}

function coercePlan(value: unknown): Plan | null {
  return typeof value === 'string' && (VALID_PLANS as readonly string[]).includes(value)
    ? (value as Plan)
    : null;
}

/**
 * Validate a license token: verify the EdDSA signature + exp with the public
 * key, then cross-check the DB to ensure the subscription has not been revoked.
 *
 * Mirrors the M4 desktop verifier (jose importSPKI/jwtVerify, alg EdDSA) and
 * adds the server-only revocation lookup keyed on the token subject.
 */
export async function validateEntitlement(token: string): Promise<ValidationResult> {
  const fail = (reason: string): ValidationResult => ({
    valid: false,
    plan: null,
    expiresAt: null,
    revoked: false,
    graceDaysLeft: null,
    sub: null,
    reason,
  });

  if (!token || typeof token !== 'string' || token.split('.').length !== 3) {
    return fail('malformed: not a compact JWT');
  }

  let key;
  try {
    key = await importSPKI(publicKeyPem, 'EdDSA');
  } catch {
    return fail('server public key import failed');
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(token, key, { algorithms: ['EdDSA'], clockTolerance: 0 });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return fail('expired');
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return fail('bad signature (wrong key or tampered)');
    }
    if (err instanceof joseErrors.JOSEError) return fail(`invalid token: ${err.code}`);
    console.error('[license-server] unexpected validation error:', err);
    return fail('verification failed');
  }

  const plan = coercePlan(payload.plan);
  if (!plan) return fail('missing or invalid plan claim');

  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (exp === null) return fail('missing exp claim');

  // Revocation cross-check. The token subject is the Clerk user_id (or, as a
  // fallback at mint time, the Stripe subscription id). Look up any matching
  // subscription that has been revoked.
  const sub = typeof payload.sub === 'string' ? payload.sub : null;
  let revoked = false;
  if (sub) {
    try {
      const rowsByClerk = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.clerkUserId, sub));
      const rowsBySubId = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, sub));
      const rows = [...rowsByClerk, ...rowsBySubId];
      revoked = rows.length > 0 && rows.every((r) => r.revokedAt !== null);
    } catch (err) {
      console.error('[license-server] revocation lookup failed (treating as not revoked):', err);
    }
  }

  if (revoked) {
    return { valid: false, plan, expiresAt: exp, revoked: true, graceDaysLeft: null, sub, reason: 'revoked' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const graceCutoff = exp + DEFAULT_GRACE_DAYS * 24 * 60 * 60;
  const graceDaysLeft = Math.max(0, Math.ceil((graceCutoff - nowSec) / 86400));

  return { valid: true, plan, expiresAt: exp, revoked: false, graceDaysLeft, sub };
}

/** Exposed for the keygen/contract-test sanity path. */
export function getDerivedPublicKeyPem(): string {
  return publicKeyPem;
}
