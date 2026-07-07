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
  if (!activeSubject) return true;
  return input.licenseSubject !== activeSubject;
}
