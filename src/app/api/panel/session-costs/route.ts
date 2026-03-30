import { NextResponse } from 'next/server';

/**
 * GET /api/panel/session-costs
 *
 * Cost telemetry for legacy mirrored sessions was removed with the retired
 * runtime bridge. The timeline UI falls back to segment-derived summaries when
 * this endpoint returns no session-level data.
 */

export async function GET() {
  return NextResponse.json({
    sessions: [],
    totals: {
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      messages: 0,
      sessions: 0,
    },
    byAgent: {},
  });
}
