import { NextResponse } from 'next/server';

import { ensureFreeEntitlement } from '@/lib/entitlement/bootstrap';
import { getEntitlement } from '@/lib/entitlement/store';

export const dynamic = 'force-dynamic';

/**
 * POST /api/panel/entitlement/bootstrap — on-demand free-allowance issuance.
 *
 * Idempotent: issues + caches a free token only when this install has none
 * (never overwrites a paid one). Returns the resolved { plan, flags, source }
 * so the caller can update without a second GET. Loopback+token gated via the
 * '/api/panel/' prefix in src/middleware.ts. Never throws (repo rule).
 */
export async function POST() {
  try {
    await ensureFreeEntitlement();
  } catch (error) {
    console.error('[entitlement] bootstrap failed:', error);
  }
  return NextResponse.json(await getEntitlement());
}
