export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { invalidateAllOwnedFleets } from '@/lib/runtimes';

/**
 * POST — flush the owned-session fleet cache across every runtime.
 *
 * Callers (e.g. active-workspace switch on the desktop) hit this so the next
 * fleet consumer rebuilds immediately instead of waiting out the 20s TTL.
 *
 * Intentionally does NOT kick a synchronous rebuild — clears cache, lets the
 * next lazy consumer rebuild. `fleetInflight` dedupes the herd.
 */
export async function POST() {
  invalidateAllOwnedFleets();
  return new NextResponse(null, { status: 204 });
}
