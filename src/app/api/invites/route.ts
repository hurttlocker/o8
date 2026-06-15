import { NextResponse } from 'next/server';
import { ensureFoundingInvites, resolveOwner } from '@/lib/invites/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/invites — the operator's founding invite set (generated on first
 * read, then returned). Gated loopback-only via middleware. The public, only
 * fields the share modal needs (no internal timestamps).
 */
export function GET() {
  try {
    const owner = resolveOwner();
    const invites = ensureFoundingInvites(owner);
    return NextResponse.json({
      owner,
      invites: invites.map((r) => ({ code: r.code, accent: r.accent, position: r.position, status: r.status })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to load invites';
    console.error('[invites] GET', message);
    return NextResponse.json({ error: 'invites_unavailable', message }, { status: 500 });
  }
}
