import { NextResponse } from 'next/server';
import { markSent, registerWithCentral } from '@/lib/invites/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/invites/sent { code } — mark a pass as handed out. */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request', message: 'Invalid JSON body.' }, { status: 400 });
  }
  const code = body && typeof body === 'object' && typeof (body as Record<string, unknown>).code === 'string'
    ? ((body as Record<string, unknown>).code as string).trim()
    : '';
  if (!code) return NextResponse.json({ error: 'missing_code' }, { status: 400 });

  try {
    const invite = markSent(code);
    if (!invite) return NextResponse.json({ error: 'unknown_code' }, { status: 404 });
    // Register the shared code with the central service so it's redeemable
    // cross-machine (best-effort; no-op when central isn't configured).
    void registerWithCentral({ code: invite.code, owner: invite.owner, accent: invite.accent, position: invite.position });
    return NextResponse.json({ ok: true, invite: { code: invite.code, accent: invite.accent, position: invite.position, status: invite.status } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'failed to mark sent';
    console.error('[invites] POST sent', message);
    return NextResponse.json({ error: 'mark_sent_failed', message }, { status: 500 });
  }
}
