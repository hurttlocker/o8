/**
 * /api/mobile/symon/watches/[id] — clear one standing watch from the phone.
 *
 * DELETE → { ok: true, watch: MobileSymonWatch } | 404
 *
 * Cancelling runs `cancelSymonWatch`, the same call `symon_watch_cancel` and the
 * operator-bearer route make: the pending fires are cleared, the row closes, and
 * one `watch_cancelled` entry lands in the Symon ledger. A saved plan body is
 * never run by a cancel.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { cancelSymonWatch } from '@/lib/automations/symon-watch';
import { mobileSymonWatch } from '@/lib/mobile/symon-watch-view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function DELETE(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const principal = resolveRequestPrincipal(request);
  if (principal === 'worker') {
    return NextResponse.json(
      { ok: false, error: 'locked', detail: 'Symon watches are not available to a dispatched worker.' },
      { status: 403 },
    );
  }
  if (principal !== 'operator' && principal !== 'device') {
    return NextResponse.json(
      { ok: false, error: 'unauthorized', detail: 'Symon watches require the operator credential or an enrolled device.' },
      { status: 401 },
    );
  }

  const { id } = await ctx.params;
  // Cancelling an already-closed watch is not an error — a phone that retries a
  // dropped request must not be told its watch vanished.
  const watch = cancelSymonWatch(id);
  if (!watch) {
    return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json(
    { ok: true, watch: mobileSymonWatch(watch) },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
