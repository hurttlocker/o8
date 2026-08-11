import 'server-only';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { importSPKI, jwtVerify, errors as joseErrors } from 'jose';

import { clearFounderRecord } from './founder';
import {
  isClerkUserSubject,
  readJwtIdentityClaims,
  shouldDropCachedLicenseForSubject,
} from './identity-guards';
import { getEntitlementPath } from './store';
import type { Plan } from './types';
import { DEFAULT_O8_API_BASE_URL } from '@/lib/hosted-service';

/**
 * Offline-first signed-license verifier (monetization M4).
 *
 * CRYPTO CHOICE — `jose`. o8 already depends on `jose@^6.2.2` and uses it in
 * three existing places (`auth/jwt.ts`, `github-broker/auth.ts`,
 * `mobile/live-activity-push.ts`). No new dependency is added. `jose` handles
 * base64url parsing, signature verification (Ed25519 / RS256), and `exp`
 * checks natively, which is exactly the JWT envelope this verifier needs.
 *
 * This is the verifier MODULE ONLY (M4). It is NOT wired into the app
 * lifecycle, the sidecar, or any route — that is M5. The cache helpers write
 * the SAME `entitlement.json` shape that `store.ts` already reads, so the store
 * picks up the verified plan without any change to store.ts.
 *
 * Never throws — every path returns a structured result.
 */

const VALID_PLANS: readonly Plan[] = ['free', 'pro', 'team', 'founder'];
const ALLOWED_ALGS = ['EdDSA', 'RS256'] as const;
const DEFAULT_GRACE_DAYS = 30;

/**
 * The hosted license service base URL. O8_PROXY_URL is the shared
 * hosted-service configuration; an ABSENT value falls back to the public
 * default so an explicit o8 managed-model request can mint its anonymous free
 * allowance with zero setup. Pure-BYO installs opt out explicitly with
 * O8_PROXY_URL=off (also: none|disabled|0|false).
 */
export function configuredLicenseServerBaseUrl(): string | null {
  const configured = process.env.O8_PROXY_URL?.trim();
  if (configured && /^(off|none|disabled|0|false)$/i.test(configured)) return null;
  return (configured || DEFAULT_O8_API_BASE_URL).replace(/\/+$/, '');
}

/**
 * Claims carried by a signed license token. `exp` is seconds-since-epoch
 * (standard JWT NumericDate), matching `jose`'s payload shape.
 */
export interface LicenseClaims {
  plan: Plan;
  exp: number;
  /** Subject — typically the licensed account / customer id. */
  sub?: string;
  /** Issued-at (seconds since epoch), if present. */
  iat?: number;
}

export interface VerifyLicenseResult {
  valid: boolean;
  plan: Plan | null;
  expiresAt: number | null;
  subject: string | null;
  reason?: string;
}

export interface VerifyLicenseOptions {
  /** Override the verification key (PEM SPKI). Falls back to env, then baked-in. */
  publicKeyPem?: string;
  /** Clock injection for testing. Seconds-since-epoch is derived from this ms value. */
  now?: number;
  /**
   * Offline-grace mode. When true, a validly-signed-but-expired license is
   * still accepted up to `graceDays` past `exp` (so a hosted-service outage never
   * bricks a paying user who holds a previously-valid token).
   */
  offlineGrace?: boolean;
  /** Grace window in days (default 30). Only used when offlineGrace is true. */
  graceDays?: number;
}

/**
 * The license-signing PUBLIC key (Ed25519 SPKI).
 *
 * This key only VERIFIES license tokens, so it is safe to ship. The matching
 * PRIVATE key stays in the hosted o8 account service and is NEVER baked into
 * this app. Under the signed-token contract, every issued token must validate
 * against this key and carry a supported plan plus a standard expiration.
 * For dev/testing, override via the O8_LICENSE_PUBKEY env var (PEM SPKI), which
 * takes precedence over this constant.
 */
const LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAbKznVejaYq8fRULz2v1DMPOwDDw6kPVMG+Q8s5/m5q8=
-----END PUBLIC KEY-----`;

function resolvePublicKeyPem(override?: string): string {
  if (override && override.trim()) return override;
  const envKey = process.env.O8_LICENSE_PUBKEY;
  if (envKey && envKey.trim()) return envKey;
  return LICENSE_PUBLIC_KEY_PEM;
}

function coercePlan(value: unknown): Plan | null {
  return typeof value === 'string' && (VALID_PLANS as readonly string[]).includes(value)
    ? (value as Plan)
    : null;
}

// In offline-grace mode we verify the SIGNATURE only and apply our OWN grace
// boundary, so jose must not reject on expiry. jose v6 has no "skip exp" flag,
// but a clockTolerance far past any real grace window effectively disables its
// exp check; our explicit grace-cutoff below is then the single source of truth.
const DISABLE_JOSE_EXP_TOLERANCE = '36500d'; // ~100y — well beyond any grace window

/**
 * Verify a signed license JWT.
 *
 * Rejects: malformed token, bad/wrong-key signature, unsupported alg, missing
 * or invalid `plan`, and expiry past the (optional) grace window. Never throws.
 */
export async function verifyLicense(
  token: string,
  opts: VerifyLicenseOptions = {},
): Promise<VerifyLicenseResult> {
  const fail = (reason: string): VerifyLicenseResult => ({
    valid: false,
    plan: null,
    expiresAt: null,
    subject: null,
    reason,
  });

  if (!token || typeof token !== 'string' || token.split('.').length !== 3) {
    return fail('malformed: not a compact JWT');
  }

  const offlineGrace = opts.offlineGrace ?? false;
  const graceDays = opts.graceDays ?? DEFAULT_GRACE_DAYS;
  const nowMs = opts.now ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  let key;
  try {
    const pem = resolvePublicKeyPem(opts.publicKeyPem);
    // alg arg only steers OID parsing for some formats; Ed25519 SPKI is
    // self-describing, so importSPKI with EdDSA works for the placeholder key.
    key = await importSPKI(pem, 'EdDSA').catch(() => importSPKI(pem, 'RS256'));
  } catch {
    return fail('invalid public key (PEM SPKI expected)');
  }

  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: [...ALLOWED_ALGS],
      // When offline-grace is on, disable jose's exp check so it does NOT
      // reject; we enforce the real grace boundary ourselves below. When off,
      // jose enforces exp strictly (zero tolerance).
      clockTolerance: offlineGrace ? DISABLE_JOSE_EXP_TOLERANCE : 0,
      currentDate: new Date(nowMs),
    });

    const plan = coercePlan((payload as { plan?: unknown }).plan);
    if (!plan) return fail('missing or invalid plan claim');

    const exp = typeof payload.exp === 'number' ? payload.exp : null;
    if (exp === null) return fail('missing exp claim');

    // Enforce the grace boundary explicitly. jose already accepted the
    // signature; here we decide whether the (possibly expired) token is still
    // usable. Without offlineGrace, jose would have thrown for exp <= now.
    if (offlineGrace) {
      const graceCutoff = exp + Math.max(0, Math.floor(graceDays)) * 24 * 60 * 60;
      if (nowSec > graceCutoff) {
        return fail('expired past grace window');
      }
    }

    return {
      valid: true,
      plan,
      expiresAt: exp,
      subject: typeof payload.sub === 'string' ? payload.sub : null,
      reason: undefined,
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) return fail('expired');
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
      return fail('bad signature (wrong key or tampered)');
    }
    if (err instanceof joseErrors.JOSEError) return fail(`invalid token: ${err.code}`);
    console.error('[entitlement] Unexpected license-verify error:', err);
    return fail('verification failed');
  }
}

/**
 * Offline-grace helper — is a validly-signed license still usable, given its
 * claims and the current time? A cached, signature-valid license stays usable
 * up to `graceDays` past `exp`. Returns false for claims with no/invalid exp.
 */
export function isWithinGrace(
  claims: Pick<LicenseClaims, 'exp'>,
  now: number = Date.now(),
  graceDays: number = DEFAULT_GRACE_DAYS,
): boolean {
  if (!claims || typeof claims.exp !== 'number') return false;
  const nowSec = Math.floor(now / 1000);
  const graceCutoff = claims.exp + Math.max(0, Math.floor(graceDays)) * 24 * 60 * 60;
  return nowSec <= graceCutoff;
}

// ── Cache (entitlement.json) ───────────────────────────────────────────────
//
// store.ts reads `entitlement.json` with shape
// { plan?, licenseKey?, status?, expiresAt? }. We write that exact shape so the
// store picks up the verified plan with NO change to store.ts. `expiresAt` is
// stored as an ISO string to match the store's `expiresAt?: string` field.

interface EntitlementCacheFile {
  plan?: Plan;
  licenseKey?: string;
  status?: string;
  expiresAt?: string;
}

interface ReadCachedEntitlementOptions {
  activeSubject?: string | null;
}

/**
 * Read the cached entitlement file. Returns null when the file is missing or
 * unreadable (the common free case). Never throws.
 */
export function readCachedEntitlement(options: ReadCachedEntitlementOptions = {}): EntitlementCacheFile | null {
  try {
    const raw = readFileSync(getEntitlementPath(), 'utf8');
    const cached = JSON.parse(raw) as EntitlementCacheFile;
    const licenseKey = typeof cached.licenseKey === 'string' ? cached.licenseKey.trim() : '';
    if (licenseKey) {
      const { subject } = readJwtIdentityClaims(licenseKey);
      if (shouldDropCachedLicenseForSubject({ licenseSubject: subject, activeSubject: options.activeSubject })) {
        clearCachedEntitlement();
        return null;
      }
    }
    return cached;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[entitlement] Failed to read entitlement cache:', error);
    }
    return null;
  }
}

/**
 * Persist a verified license result into `entitlement.json` so store.ts picks
 * up the plan. Writes only the store-compatible fields. Never throws — returns
 * true on success, false on failure.
 */
export function writeCachedEntitlement(input: {
  plan: Plan;
  status: string;
  expiresAt: number | null;
  licenseKey?: string;
}): boolean {
  try {
    const filePath = getEntitlementPath();
    mkdirSync(path.dirname(filePath), { recursive: true });
    const file: EntitlementCacheFile = {
      plan: input.plan,
      status: input.status,
      ...(input.licenseKey ? { licenseKey: input.licenseKey } : {}),
      ...(input.expiresAt !== null
        ? { expiresAt: new Date(input.expiresAt * 1000).toISOString() }
        : {}),
    };
    writeFileSync(filePath, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch (error) {
    console.error('[entitlement] Failed to write entitlement cache:', error);
    return false;
  }
}

export function clearCachedEntitlement(): void {
  try {
    rmSync(getEntitlementPath(), { force: true });
    clearFounderRecord();
  } catch (error) {
    console.error('[entitlement] Failed to clear entitlement cache:', error);
  }
}

/**
 * Clear only an account-portable entitlement during o8 account sign-out.
 * Install-scoped free allowance tokens and manually-applied machine licenses
 * are local state, so signing out of Clerk must not discard them.
 */
export function clearCachedAccountEntitlement(): boolean {
  const cached = readCachedEntitlement();
  const token = cached?.licenseKey?.trim();
  if (!token) return false;
  const { subject } = readJwtIdentityClaims(token);
  if (!isClerkUserSubject(subject)) return false;
  clearCachedEntitlement();
  return true;
}
