import { NextResponse, NextRequest } from 'next/server';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const fleetMode = req.nextUrl.searchParams.get('fleetMode') as 'smart' | 'all' | null;
  const fresh = req.nextUrl.searchParams.get('fresh') === '1';
  const snapshot = await getRuntimeInventorySnapshot({ fleetMode: fleetMode ?? 'smart', fresh });

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
