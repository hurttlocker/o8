import { createRemoteJWKSet, jwtVerify } from 'jose';

import { isAuthorizedClerkParty } from './clerk-authorized-party.js';
import { env } from './env.js';

/**
 * Verify a Clerk SESSION JWT against the configured Clerk instance's JWKS and
 * return the authenticated Clerk user id (`sub`).
 *
 * This is what lets a signed-in desktop pull its OWN license from
 * /account/license with NO shared secret shipped in the app — the session token
 * the user already holds is the only credential, and it can only ever resolve
 * to their own account. Returns null when CLERK_ISSUER is unset (feature off)
 * or the token is missing / invalid / expired. Never throws.
 */

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!env.CLERK_ISSUER) return null;
  if (!jwks) {
    // Clerk publishes its signing keys at <issuer>/.well-known/jwks.json.
    jwks = createRemoteJWKSet(new URL('/.well-known/jwks.json', env.CLERK_ISSUER));
  }
  return jwks;
}

export async function verifyClerkSession(token: string | null): Promise<string | null> {
  if (!token) return null;
  const keySet = getJwks();
  if (!keySet) return null;
  try {
    const { payload } = await jwtVerify(token, keySet, { issuer: env.CLERK_ISSUER });
    // Authorized-party check (audit #4): a signature+issuer-valid token from a
    // sibling app on an allowed Clerk subdomain would otherwise be redeemable
    // here for a repo-write GitHub token. Browser tokens carry `azp` and require
    // an exact allowlist match. Clerk native-mode tokens intentionally omit the
    // claim because they use Authorization without Origin; Clerk's verification
    // guidance says to skip this comparison when the claim does not exist.
    if (!isAuthorizedClerkParty(payload.azp, env.CLERK_AUTHORIZED_PARTIES)) {
      const azp = typeof payload.azp === 'string' ? payload.azp : '<malformed>';
      console.warn(`[clerk-verify] rejected token: azp "${azp}" not in authorized parties`);
      return null;
    }
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch (err) {
    console.warn(
      '[account-license] clerk session verify failed:',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
