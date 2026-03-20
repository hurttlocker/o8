export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { fetchGitHubUser, fetchGitHubEmail } from '@/lib/auth/github';
import { findOrCreateByGithub } from '@/lib/db/users';
import { signToken } from '@/lib/auth/jwt';

/**
 * POST /api/v2/auth/github
 *
 * Called after the device flow completes with a GitHub access token.
 * Creates or updates the user in our database and returns a JWT.
 *
 * Body: { accessToken: string }
 * Returns: { ok, token, user }
 */
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const accessToken = body.accessToken?.trim();

    if (!accessToken) {
      return NextResponse.json(
        { error: 'accessToken is required' },
        { status: 400 },
      );
    }

    // Fetch GitHub profile
    const ghUser = await fetchGitHubUser(accessToken);
    if (!ghUser) {
      return NextResponse.json(
        { error: 'Failed to fetch GitHub user profile. Token may be invalid.' },
        { status: 401 },
      );
    }

    // Fetch email if not in profile (private email)
    let email = ghUser.email;
    if (!email) {
      email = await fetchGitHubEmail(accessToken);
    }

    // Create or update user in our database
    const user = findOrCreateByGithub(ghUser.id, {
      email: email ?? undefined,
      name: ghUser.name ?? ghUser.login,
      avatarUrl: ghUser.avatar_url,
    });

    // Sign JWT
    const token = await signToken({
      uid: user.id,
      ghUser: ghUser.login,
      plan: user.plan,
    });

    // Set cookie + return token
    const response = NextResponse.json({
      ok: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
        plan: user.plan,
        githubUsername: ghUser.login,
      },
    });

    // Set HTTP-only cookie for browser auth (30 day expiry)
    response.cookies.set('cortex-ide-token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60, // 30 days
      path: '/',
    });

    return response;
  } catch (err) {
    console.error('[auth/github] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Authentication failed' },
      { status: 500 },
    );
  }
}
