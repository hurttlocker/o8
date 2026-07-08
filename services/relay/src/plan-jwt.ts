import { importSPKI, jwtVerify, errors as joseErrors } from 'jose';

import { isPlan, type Plan } from './entitlement.js';

/**
 * Plan-JWT verifier — PURE (the SPKI public key + issuer are injected, no env
 * import), so it unit-tests with a throwaway keypair and index.ts binds the real
 * env values. Same method the desktop (src/lib/entitlement/license.ts) and the
 * license server (validate.ts) use: importSPKI(pem, 'EdDSA') + jwtVerify with
 * clockTolerance 0.
 *
 * The relay has NO database, so there is NO revocation cross-check — revocation is
 * decided on the Mac (per-device 4401), the zero-knowledge point (docs constraint 3).
 * The relay only answers "validly-signed, unexpired, correctly-issued plan token?".
 *
 * Never throws — returns a structured result the ws upgrade handler turns into a
 * 4409 close on failure.
 */

export type PlanTokenResult =
  | { ok: true; plan: Plan; sub: string | null; exp: number }
  | { ok: false; reason: string };

export interface VerifyOpts {
  publicKeyPem: string;
  issuer: string;
}

// Cache the imported key per PEM (importSPKI is async + repeated per connection).
// Use jose's own inferred key type (avoids naming the DOM-only `CryptoKey`, which
// isn't in the ES2022 lib — mirrors how license-server leaves it un-annotated).
type ImportedKey = Awaited<ReturnType<typeof importSPKI>>;
const keyCache = new Map<string, Promise<ImportedKey>>();
function importKey(pem: string): Promise<ImportedKey> {
  let p = keyCache.get(pem);
  if (!p) {
    p = importSPKI(pem, 'EdDSA');
    keyCache.set(pem, p);
  }
  return p;
}

export async function verifyPlanTokenWith(
  token: string | undefined | null,
  opts: VerifyOpts,
): Promise<PlanTokenResult> {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw || raw.split('.').length !== 3) {
    return { ok: false, reason: 'malformed: not a compact JWT' };
  }

  let key: ImportedKey;
  try {
    key = await importKey(opts.publicKeyPem);
  } catch {
    return { ok: false, reason: 'relay public key import failed' };
  }

  let payload: Record<string, unknown>;
  try {
    const verified = await jwtVerify(raw, key, {
      algorithms: ['EdDSA'],
      clockTolerance: 0,
      issuer: opts.issuer,
    });
    payload = verified.payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return { ok: false, reason: 'expired' };
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, reason: 'bad signature (wrong key or tampered)' };
    }
    if (err instanceof joseErrors.JWTClaimValidationFailed) {
      return { ok: false, reason: `claim invalid: ${err.claim}` };
    }
    if (err instanceof joseErrors.JOSEError) return { ok: false, reason: `invalid token: ${err.code}` };
    return { ok: false, reason: 'verification failed' };
  }

  if (!isPlan(payload.plan)) return { ok: false, reason: 'missing or invalid plan claim' };
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (exp === null) return { ok: false, reason: 'missing exp claim' };
  const sub = typeof payload.sub === 'string' ? payload.sub : null;

  return { ok: true, plan: payload.plan, sub, exp };
}
