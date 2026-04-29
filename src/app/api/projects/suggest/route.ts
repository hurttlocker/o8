/**
 * #899 — Stage 2 project suggestion endpoint.
 *
 * POST  /api/projects/suggest        — returns cached suggestions, recomputes if invalidated.
 * POST  /api/projects/suggest?force=1 — bypasses the cache and calls Gemini fresh.
 *
 * Loopback / bearer-token gated by `src/middleware.ts` (covered by the
 * `/api/projects` GATED_PREFIXES entry).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { suggestProjects } from '@/lib/projects/suggest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export async function POST(req: NextRequest) {
  const denied = requirePanelAuth(req);
  if (denied) return denied;

  const force = req.nextUrl.searchParams.get('force') === '1'
    || req.nextUrl.searchParams.get('force') === 'true';

  try {
    const result = await suggestProjects({ force });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to compute suggestions.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
