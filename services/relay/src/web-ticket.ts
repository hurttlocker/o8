import { errors as joseErrors, importSPKI, jwtVerify } from 'jose';

export const WEB_RELAY_AUDIENCE = 'o8-relay-web';
export const WEB_SESSION_COOKIE = '__Host-o8-web-session';
export const RELAY_WEB_ORIGIN = 'https://relay.o8.run';
export const ALLOWED_WEB_ORIGINS = new Set([
  'https://o8.run',
  'https://www.o8.run',
]);

export interface WebTicketClaims {
  accountId: string;
  machineId: string;
  exp: number;
}

export type WebTicketResult =
  | { ok: true; claims: WebTicketClaims }
  | {
    ok: false;
    reason: 'malformed' | 'expired' | 'wrong_audience' | 'invalid_claims' | 'invalid';
  };

export interface VerifyWebTicketOptions {
  publicKeyPem: string;
  issuer: string;
  now?: Date;
}

type ImportedKey = Awaited<ReturnType<typeof importSPKI>>;
const keyCache = new Map<string, Promise<ImportedKey>>();

function importKey(pem: string): Promise<ImportedKey> {
  let pending = keyCache.get(pem);
  if (!pending) {
    pending = importSPKI(pem, 'EdDSA');
    keyCache.set(pem, pending);
  }
  return pending;
}

export async function verifyWebSessionTicketWith(
  token: string | null | undefined,
  options: VerifyWebTicketOptions,
): Promise<WebTicketResult> {
  const raw = typeof token === 'string' ? token.trim() : '';
  if (!raw || raw.split('.').length !== 3) {
    return { ok: false, reason: 'malformed' };
  }

  try {
    const key = await importKey(options.publicKeyPem);
    const verified = await jwtVerify(raw, key, {
      algorithms: ['EdDSA'],
      audience: WEB_RELAY_AUDIENCE,
      issuer: options.issuer,
      clockTolerance: 0,
      currentDate: options.now,
    });
    const payload = verified.payload;
    if (
      typeof payload.accountId !== 'string'
      || !payload.accountId
      || typeof payload.machineId !== 'string'
      || !payload.machineId
      || typeof payload.exp !== 'number'
    ) {
      return { ok: false, reason: 'invalid_claims' };
    }
    return {
      ok: true,
      claims: {
        accountId: payload.accountId,
        machineId: payload.machineId,
        exp: payload.exp,
      },
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      return { ok: false, reason: 'expired' };
    }
    if (
      error instanceof joseErrors.JWTClaimValidationFailed
      && error.claim === 'aud'
    ) {
      return { ok: false, reason: 'wrong_audience' };
    }
    return { ok: false, reason: 'invalid' };
  }
}

export function isAllowedWebOrigin(origin: string | undefined): origin is string {
  return typeof origin === 'string' && ALLOWED_WEB_ORIGINS.has(origin);
}

export function isAllowedBrowserSurfaceOrigin(origin: string | undefined): boolean {
  return origin === RELAY_WEB_ORIGIN || isAllowedWebOrigin(origin);
}

export function webSessionTicketFromCookie(
  cookieHeader: string | string[] | undefined,
): string | null {
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== WEB_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value && value.length <= 8_192 ? value : null;
  }
  return null;
}

export function webSessionCookie(ticket: string, exp: number, nowMs: number): string {
  const maxAge = Math.max(0, exp - Math.floor(nowMs / 1_000));
  return [
    `${WEB_SESSION_COOKIE}=${ticket}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
  ].join('; ');
}
