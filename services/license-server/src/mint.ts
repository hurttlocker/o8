import { SignJWT, importPKCS8 } from 'jose';

import { env } from './env.js';

/**
 * License plan tiers. MUST stay in sync with the desktop `Plan` type
 * (src/lib/entitlement/types.ts) — 'free' | 'pro' | 'team' | 'founder'.
 * ('founder' = the one-time Founding Operator tier; managed inference for life
 * within the proxy fair-use cap.)
 */
export type Plan = 'free' | 'pro' | 'team' | 'founder';

export interface MintLicenseInput {
  /** The entitlement tier this token grants. */
  plan: Plan;
  /**
   * Subject — the licensed account id. We use the Clerk user_id carried in the
   * Stripe checkout metadata. Optional, but strongly recommended.
   */
  sub?: string;
  /** Validity window in days from now. */
  days: number;
}

/**
 * Mint a signed license JWT.
 *
 * The token is produced to EXACTLY match what the M4 desktop verifier
 * (src/lib/entitlement/license.ts `verifyLicense`) expects:
 *   - protected header alg: 'EdDSA' (Ed25519)
 *   - claims: { plan, iss }  + standard sub / iat / exp (seconds-epoch)
 *   - signed with the Ed25519 PRIVATE key (PKCS8 PEM)
 *
 * The desktop bakes the matching PUBLIC key (SPKI PEM) and verifies via
 * `importSPKI(pem, 'EdDSA')` + `jwtVerify`. As long as the keypair matches and
 * the alg is EdDSA, server tokens validate on the desktop with zero clock
 * tolerance.
 */
export async function mintLicense(input: MintLicenseInput): Promise<string> {
  const { plan, sub, days } = input;

  const privateKey = await importPKCS8(env.LICENSE_PRIVATE_KEY, 'EdDSA');

  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + Math.max(1, Math.floor(days)) * 24 * 60 * 60;

  let builder = new SignJWT({ plan, iss: env.ISSUER })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt(nowSec)
    .setExpirationTime(expSec);

  if (sub && sub.trim()) {
    builder = builder.setSubject(sub.trim());
  }

  return builder.sign(privateKey);
}
