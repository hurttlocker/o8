import { NextResponse } from 'next/server';
import { listPolicySummaries } from '@/lib/approvals/policies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/panel/approvals/policies — list all active governance policy rules.
 */
export async function GET() {
  const policies = listPolicySummaries();
  return NextResponse.json({ policies }, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
