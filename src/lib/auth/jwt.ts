/**
 * JWT Utilities — Sign and verify tokens for user auth
 *
 * Uses `jose` (edge-runtime compatible, zero Node.js crypto dependency).
 * Secret comes from CORTEX_IDE_JWT_SECRET env var.
 * Auto-generates a persistent secret on first run if not set.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';

// ── Secret management ──

const DATA_DIR = getDataDir();
const SECRET_FILE = path.join(DATA_DIR, '.jwt-secret');

function getSecret(): Uint8Array {
  // Prefer env var
  const envSecret = process.env.CORTEX_IDE_JWT_SECRET;
  if (envSecret) {
    return new TextEncoder().encode(envSecret);
  }

  // Fall back to persistent file (auto-generated on first run)
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }

  if (existsSync(SECRET_FILE)) {
    const saved = readFileSync(SECRET_FILE, 'utf-8').trim();
    return new TextEncoder().encode(saved);
  }

  // Generate and persist
  const generated = randomBytes(48).toString('base64url');
  writeFileSync(SECRET_FILE, generated, { mode: 0o600 });
  console.log('[auth] Generated new JWT secret at', SECRET_FILE);
  return new TextEncoder().encode(generated);
}

const secret = getSecret();

// ── Token payload ──

export interface UserTokenPayload extends JWTPayload {
  /** User ID (UUID) */
  uid: string;
  /** GitHub username */
  ghUser?: string;
  /** Plan tier */
  plan: string;
}

// ── Sign ──

/**
 * Create a signed JWT for a user. Default expiry: 30 days.
 */
export async function signToken(payload: Omit<UserTokenPayload, 'iat' | 'exp'>): Promise<string> {
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .setIssuer('cortex-ide')
    .sign(secret);
}

/**
 * Create a short-lived token (for sensitive operations).
 */
export async function signShortToken(payload: Omit<UserTokenPayload, 'iat' | 'exp'>): Promise<string> {
  return new SignJWT(payload as JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .setIssuer('cortex-ide')
    .sign(secret);
}

// ── Verify ──

/**
 * Verify and decode a JWT. Returns the payload or null if invalid/expired.
 */
export async function verifyToken(token: string): Promise<UserTokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: 'cortex-ide',
    });
    return payload as UserTokenPayload;
  } catch {
    return null;
  }
}
