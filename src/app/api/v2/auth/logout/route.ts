export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { hashToken, deleteSessionByTokenHash, purgeExpiredSessions } from '@/lib/db/sessions';

/**
 * POST /api/v2/auth/logout
 *
 * Revokes the session (deletes DB row) and clears the auth cookie.
 * Token is immediately invalid even if not expired.
 */
export async function POST(request: NextRequest) {
  // Revoke the session in the database
  const token = request.cookies.get('o8-token')?.value;
  if (token) {
    deleteSessionByTokenHash(hashToken(token));
  }

  // Opportunistic cleanup of expired sessions
  try { purgeExpiredSessions(); } catch { /* non-critical */ }

  const response = NextResponse.json({ ok: true });

  response.cookies.set('o8-token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  return response;
}
