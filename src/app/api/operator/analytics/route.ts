import { NextResponse } from 'next/server';

import { proxyBaseUrl } from '@/lib/cortex/qa/llm/inference-route';

export const dynamic = 'force-dynamic';

/**
 * GET /api/operator/analytics — usage-analytics dashboard data (epic #1249).
 *
 * Founder-only by construction: this forwards to the license server's
 * ADMIN-guarded `/admin/analytics`, authenticating with O8_ANALYTICS_ADMIN_TOKEN
 * read from the operator's own environment. A normal install has no such token,
 * so it returns { available: false } and the dashboard surface stays hidden —
 * the admin token never ships in a build, it lives only in the founder's shell.
 *
 * Already loopback+token gated via the '/api/operator/' prefix in
 * src/middleware.ts. Never throws (repo rule) — all failures are structured.
 */
export async function GET() {
  const adminToken = process.env.O8_ANALYTICS_ADMIN_TOKEN?.trim();
  if (!adminToken) {
    return NextResponse.json({ available: false, reason: 'no operator analytics token on this install' });
  }

  try {
    const res = await fetch(`${proxyBaseUrl()}/admin/analytics`, {
      headers: { Authorization: `Bearer ${adminToken}` },
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
