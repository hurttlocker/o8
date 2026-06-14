import 'server-only';
import { auth } from '@clerk/nextjs/server';
import { findUserByClerkId } from '@/lib/db/users';

const CLERK_ENABLED = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || process.env.CLERK_PUBLISHABLE_KEY,
);

/**
 * Resolve the current signed-in user from the Clerk session, mapped to our
 * local `users` row. Shared by every API route — default + canvas.
 *
 * Returns null when Clerk is disabled, no session is present, or the Clerk user
 * hasn't been provisioned locally yet. Read-only: provisioning
 * (findOrCreateByClerk) happens once at sign-in (P1 ticket exchange), not on
 * every request.
 */
export async function getCurrentUser() {
  if (!CLERK_ENABLED) return null;
  try {
    const { userId } = await auth();
    if (!userId) return null;
    return findUserByClerkId(userId);
  } catch {
    // auth() throws when clerkMiddleware didn't run for this route; treat as
    // "no user" rather than failing the request.
    return null;
  }
}
