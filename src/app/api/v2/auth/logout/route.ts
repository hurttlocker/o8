export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

/**
 * POST /api/v2/auth/logout
 *
 * Clears the auth cookie. Frontend should also clear localStorage token.
 */
export async function POST() {
  const response = NextResponse.json({ ok: true });

  response.cookies.set('cortex-ide-token', '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 0,
    path: '/',
  });

  return response;
}
