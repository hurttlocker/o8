import { NextResponse } from 'next/server';

import { resolveFlags } from '@/lib/entitlement/flags';
import { getEntitlement } from '@/lib/entitlement/store';

export const dynamic = 'force-dynamic';

/**
 * GET /api/panel/entitlement — returns the resolved { plan, flags, source }.
 * Already loopback+token gated via GATED_PREFIXES ('/api/panel/') in
 * src/middleware.ts. Never throws (repo rule): falls back to free on any error.
 */
export async function GET() {
  try {
    const entitlement = await getEntitlement();
    return NextResponse.json(entitlement);
  } catch (error) {
    console.error('[entitlement] route failed:', error);
    return NextResponse.json({ plan: 'free', flags: resolveFlags('free'), source: 'default' });
  }
}
