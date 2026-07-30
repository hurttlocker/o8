import { NextResponse } from 'next/server';
import { redeemInvite } from '@/lib/invites/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/invites/redeem { code, redeemedBy? } — LOCAL-ONLY redeem stub.
 *
 * The public invite API contract redeems cross-machine passes through
 * `POST /invites/redeem` on the hosted service, not here, because the code row
 * only exists on the inviter's install. This resolves same-install codes so
 * the local contract remains wired and testable.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request', message: 'Invalid JSON body.' }, { status: 400 });
  }
  const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const code = typeof rec.code === 'string' ? rec.code.trim() : '';
  const redeemedBy = typeof rec.redeemedBy === 'string' ? rec.redeemedBy.trim() : '';
  if (!code) return NextResponse.json({ error: 'missing_code' }, { status: 400 });

  try {
    const result = redeemInvite(code, redeemedBy);
    if (!result.ok) {
      return NextResponse.json({ ok: false, reason: result.reason }, { status: result.reason === 'unknown_code' ? 404 : 409 });
    }
    return NextResponse.json({ ok: true, invite: result.invite ? { code: result.invite.code, status: result.invite.status } : null });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to redeem';
    console.error('[invites] POST redeem', message);
    return NextResponse.json({ error: 'redeem_failed', message }, { status: 500 });
  }
}
