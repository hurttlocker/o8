import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';

import { findOrCreateByClerk } from '@/lib/db/users';

export const dynamic = 'force-dynamic';

interface ProvisionBody {
  clerkUserId?: unknown;
  githubId?: unknown;
  email?: unknown;
  name?: unknown;
  avatarUrl?: unknown;
}

/**
 * POST /api/panel/auth/clerk-provision — mirror the active Clerk user into the
 * local `users` table (findOrCreateByClerk).
 *
 * The authoritative clerkUserId comes from the VERIFIED Clerk session (auth()),
 * not the request body — profile fields are taken from the client's already-
 * authenticated session. Loopback + ws-token gated via GATED_PREFIXES
 * ('/api/panel/') in src/middleware.ts. Never throws (repo rule).
 */
export async function POST(request: Request) {
  try {
    const { userId } = await auth();
    if (!userId) {
      return NextResponse.json({ ok: false, reason: 'no_session' }, { status: 401 });
    }

    let body: ProvisionBody = {};
    try {
      body = (await request.json()) as ProvisionBody;
    } catch {
      /* empty/invalid body is fine — we still provision from the session */
    }

    const githubId =
      typeof body.githubId === 'number'
        ? body.githubId
        : typeof body.githubId === 'string' && /^\d+$/.test(body.githubId)
          ? Number(body.githubId)
          : undefined;

    const user = findOrCreateByClerk(userId, {
      githubId,
      email: typeof body.email === 'string' ? body.email : undefined,
      name: typeof body.name === 'string' ? body.name : undefined,
      avatarUrl: typeof body.avatarUrl === 'string' ? body.avatarUrl : undefined,
    });

    return NextResponse.json({ ok: true, userId: user?.id ?? null, plan: user?.plan ?? 'free' });
  } catch (error) {
    console.error('[clerk-provision] failed:', error);
    return NextResponse.json({ ok: false, reason: 'error' });
  }
}
