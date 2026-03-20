export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { withAuth } from '@/lib/auth/middleware';
import { getUserProfile } from '@/lib/db/users';

/**
 * GET /api/v2/auth/session
 *
 * Returns the current authenticated user's profile.
 * Used by the frontend to check if the user is signed in.
 */
export const GET = withAuth(async (_req, { user }) => {
  const profile = getUserProfile(user.id);

  if (!profile) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    user: profile,
  });
});
