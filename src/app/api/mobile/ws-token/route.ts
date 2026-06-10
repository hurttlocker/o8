import { NextRequest, NextResponse } from 'next/server';
import { headersIndicateLoopback } from '@/lib/auth/loopback-request';
import { getOrCreateWsToken } from '@/lib/ws-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Returns the master ws-token. Defense in depth: the /api/mobile/ middleware
 * gate already requires loopback-or-bearer, and this handler ALSO refuses
 * non-loopback callers outright — a route whose only job is handing out the
 * credential must never answer the network. LAN clients receive the token via
 * the pairing QR / #tk= link, never by asking for it.
 */
export async function GET(request: NextRequest) {
  if (!headersIndicateLoopback((name) => request.headers.get(name))) {
    return NextResponse.json(
      { error: 'Pairing token is only available to local clients.' },
      { status: 403 },
    );
  }
  return NextResponse.json(
    { token: getOrCreateWsToken() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
