import { NextRequest, NextResponse } from 'next/server';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const fleetMode = request.nextUrl.searchParams.get('fleetMode') as 'smart' | 'all' | null;
  const fresh = request.nextUrl.searchParams.get('fresh') === '1';
  const includeOpenClaw = request.nextUrl.searchParams.get('includeOpenClaw') !== '0';
  const snapshot = await getRuntimeInventorySnapshot({
    fleetMode: fleetMode ?? 'smart',
    fresh,
    includeOpenClaw,
  });

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
