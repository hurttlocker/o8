import { NextResponse } from 'next/server';

import { resolveRequestPrincipalContext } from '@/lib/auth/principal';

export function broadcastNoStore<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}

export function requireBroadcastReader(request: Request): NextResponse | null {
  const role = resolveRequestPrincipalContext(request).role;
  if (role === 'operator' || role === 'spectator') return null;
  return broadcastNoStore({
    schema: 'o8/broadcast.error/v1',
    ok: false,
    error: {
      code: 'broadcast_reader_forbidden',
      message: 'Broadcast requires an operator or spectator credential.',
    },
  }, 403);
}

export function requireBroadcastOperator(request: Request): NextResponse | null {
  if (resolveRequestPrincipalContext(request).role === 'operator') return null;
  return broadcastNoStore({
    schema: 'o8/broadcast.error/v1',
    ok: false,
    error: {
      code: 'broadcast_operator_forbidden',
      message: 'Broadcast token management requires an operator credential.',
    },
  }, 403);
}
