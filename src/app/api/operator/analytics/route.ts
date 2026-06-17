import { NextResponse } from 'next/server';

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';

export const dynamic = 'force-dynamic';

/**
 * GET /api/operator/analytics — usage-analytics dashboard data (epic #1249).
 *
 * Founder-only by construction: this forwards to the license server's
 * `/admin/analytics`, authenticating with a READ-ONLY O8_ANALYTICS_TOKEN read
 * from the operator's own environment (scoped so it can only read stats, never
 * mint/revoke licenses). A normal install has no such token, so it returns
 * { available: false } and the dashboard surface stays hidden — the token never
 * ships in a build, it lives only in the founder's login shell.
 *
 * Already loopback+token gated via the '/api/operator/' prefix in
 * src/middleware.ts. Never throws (repo rule) — all failures are structured.
 */
export async function GET() {
  const analyticsToken = process.env.O8_ANALYTICS_TOKEN?.trim();
  if (!analyticsToken) {
    return NextResponse.json({ available: false, reason: 'no operator analytics token on this install' });
  }

  try {
    const res = await fetch(`${proxyBaseUrl()}/admin/analytics`, {
      headers: { Authorization: `Bearer ${analyticsToken}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ available: false, reason: `upstream ${res.status}` });
    }
    const data = await res.json();
    return NextResponse.json({ available: true, data });
  } catch (error) {
    return NextResponse.json({
      available: false,
      reason: error instanceof Error ? error.message : 'fetch failed',
    });
  }
}
