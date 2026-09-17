/**
 * /api/mobile/symon/watches — what Symon is still waiting on, read from the phone.
 *
 * GET → { ok: true, watches: MobileSymonWatch[] }
 *
 * The operator-bearer route at `/api/symon/watches` is the tools' surface and is
 * not on the device allowlist, so before this a paired phone could only learn
 * about its standing intents by opening a voice session and asking Symon to call
 * `symon_watch_list`. This is the same data, readable without a session.
 *
 * Read only. Registering a watch stays inside a turn, where it cards.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { resolveRequestPrincipal } from '@/lib/auth/principal';
import { listSymonWatches } from '@/lib/automations/symon-watch';
import { mobileSymonWatch } from '@/lib/mobile/symon-watch-view';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  // Accept the operator credential OR an enrolled device: the phone reaches this
  // over the relay with its per-device bearer and a non-loopback client address.
  // A dispatched worker has no business reading the operator's standing intents.
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

  // Every watch on this install, settled ones included: a phone that was away
  // when one fired needs the ledger tail to see what happened to it.
  return NextResponse.json(
    { ok: true, watches: listSymonWatches().map(mobileSymonWatch) },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
