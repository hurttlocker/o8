import 'server-only';

export interface JwtIdentityClaims {
  iat: number | null;
  subject: string | null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function readJwtIdentityClaims(token: string): JwtIdentityClaims {
  const payload = decodeJwtPayload(token);
  const iat = payload && typeof payload.iat === 'number' && Number.isFinite(payload.iat)
    ? payload.iat
    : null;
  const subject = payload && typeof payload.sub === 'string' ? payload.sub : null;
  return { iat, subject };
}

export function tokenIssuedAt(token: string): number | null {
  return readJwtIdentityClaims(token).iat;
}

export function isClerkUserSubject(subject: string | null | undefined): boolean {
  return typeof subject === 'string' && subject.startsWith('user_');
}

export function shouldDropCachedLicenseForSubject(input: {
  licenseSubject: string | null;
  activeSubject?: string | null;
}): boolean {
  if (!isClerkUserSubject(input.licenseSubject)) return false;
  const activeSubject = input.activeSubject?.trim() || null;
  // UNKNOWN active subject ≠ mismatch (#1483). Desktop native mode keeps the
  // Clerk session in the Tauri store, NOT in cookies, so server-side auth()
  // sees no user and activeSubject is null on EVERY desktop read. Dropping on
  // null silently wiped founder licenses and fell the app back to a free token.
  // Only drop when we KNOW the active subject AND it genuinely conflicts with
  // the license's subject; when unknown, keep the cached license — the 30-day
  // offline grace in license.ts is the staleness backstop, and the sync route
  // (license_subject_mismatch) still catches genuine cross-user swaps at sign-in.
  if (!activeSubject) return false;
  return input.licenseSubject !== activeSubject;
}
