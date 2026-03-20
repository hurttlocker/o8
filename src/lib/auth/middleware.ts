/**
 * Auth Middleware — protect v2 API routes
 *
 * Wraps a Next.js route handler to require a valid JWT.
 * Injects the authenticated user into the request context.
 *
 * Usage:
 *   export const POST = withAuth(async (req, { user }) => {
 *     // user is guaranteed to exist here
 *     return NextResponse.json({ hello: user.name });
 *   });
 */

import { NextResponse, type NextRequest } from 'next/server';
import { verifyToken, type UserTokenPayload } from './jwt';
import { findUserById } from '@/lib/db/users';

// ── Types ──

export interface AuthContext {
  /** JWT payload */
  token: UserTokenPayload;
  /** Full user record from database */
  user: NonNullable<ReturnType<typeof findUserById>>;
}

export type AuthHandler = (
  request: NextRequest,
  context: AuthContext,
) => Promise<NextResponse> | NextResponse;

// ── Middleware ──

/**
 * Wrap a route handler with JWT authentication.
 * Returns 401 if no token or invalid. Returns 403 if user not found in DB.
 */
export function withAuth(handler: AuthHandler) {
  return async (request: NextRequest): Promise<NextResponse> => {
    // Extract token from Authorization header or cookie
    const authHeader = request.headers.get('Authorization');
    let token: string | null = null;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      // Fall back to cookie
      token = request.cookies.get('cortex-ide-token')?.value ?? null;
    }

    if (!token) {
      return NextResponse.json(
        { error: 'Authentication required. Provide a Bearer token or sign in.' },
        { status: 401 },
      );
    }

    // Verify JWT
    const payload = await verifyToken(token);
    if (!payload) {
      return NextResponse.json(
        { error: 'Invalid or expired token. Please sign in again.' },
        { status: 401 },
      );
    }

    // Look up user in database
    const user = findUserById(payload.uid);
    if (!user) {
      return NextResponse.json(
        { error: 'User not found. Account may have been deleted.' },
        { status: 403 },
      );
    }

    // Call the actual handler with auth context
    return handler(request, { token: payload, user });
  };
}

/**
 * Optional auth — doesn't block if no token, but provides user if available.
 */
export function withOptionalAuth(
  handler: (request: NextRequest, context: AuthContext | null) => Promise<NextResponse> | NextResponse,
) {
  return async (request: NextRequest): Promise<NextResponse> => {
    const authHeader = request.headers.get('Authorization');
    let token: string | null = null;

    if (authHeader?.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    } else {
      token = request.cookies.get('cortex-ide-token')?.value ?? null;
    }

    if (!token) {
      return handler(request, null);
    }

    const payload = await verifyToken(token);
    if (!payload) {
      return handler(request, null);
    }

    const user = findUserById(payload.uid);
    if (!user) {
      return handler(request, null);
    }

    return handler(request, { token: payload, user });
  };
}
