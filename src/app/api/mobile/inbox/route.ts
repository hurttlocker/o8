import { NextRequest, NextResponse } from 'next/server';
import { getMobileInboxSnapshot } from '@/lib/mobile/inbox';
import { performance } from 'node:perf_hooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const startedAt = performance.now();
  const fresh = req.nextUrl.searchParams.get('fresh') === '1';
  const snapshot = await getMobileInboxSnapshot({ fresh });

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
    },
  });
}
