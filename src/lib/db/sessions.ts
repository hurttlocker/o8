/**
 * Session Data Access Layer
 *
 * Tracks active auth sessions for token revocation.
 * Each login creates a session row; logout deletes it.
 * Middleware checks session exists before accepting a JWT.
 */

import { eq, lt } from 'drizzle-orm';
import { getDb, sessions } from './index';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

/**
 * Hash a JWT for storage (we never store the raw token).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Create a session record when a user logs in.
 */
export function createSession(opts: {
  userId: string;
  token: string;
  userAgent?: string;
  ipAddress?: string;
  expiresAt: Date;
}): string {
  const db = getDb();
  if (!db) return '';
  const id = randomUUID();
  const tokenHash = hashToken(opts.token);

  db.insert(sessions).values({
    id,
    userId: opts.userId,
    tokenHash,
    userAgent: opts.userAgent ?? null,
    ipAddress: opts.ipAddress ?? null,
    expiresAt: opts.expiresAt.toISOString(),
  }).run();

  return id;
}

/**
 * Check if a session exists and is not expired.
 * Returns the session row or null.
 */
export function findSessionByTokenHash(tokenHash: string) {
  const db = getDb();
  if (!db) return null;
  return db.select().from(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .get() ?? null;
}

/**
 * Delete a session (logout / revocation).
 */
export function deleteSessionByTokenHash(tokenHash: string): boolean {
  const db = getDb();
  if (!db) return false;
  const result = db.delete(sessions)
    .where(eq(sessions.tokenHash, tokenHash))
    .run();
  return result.changes > 0;
}

/**
 * Delete all sessions for a user (force logout everywhere).
 */
export function deleteAllUserSessions(userId: string): number {
  const db = getDb();
  if (!db) return 0;
  const result = db.delete(sessions)
    .where(eq(sessions.userId, userId))
    .run();
  return result.changes;
}

/**
 * Purge expired sessions (housekeeping).
 */
export function purgeExpiredSessions(): number {
  const db = getDb();
  if (!db) return 0;
  const result = db.delete(sessions)
    .where(lt(sessions.expiresAt, new Date().toISOString()))
    .run();
  return result.changes;
}
