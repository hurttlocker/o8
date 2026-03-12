import { NextResponse } from 'next/server';
import { getOpenClawFleetSnapshot } from '@/lib/openclaw/fleet';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const snapshot = await getOpenClawFleetSnapshot();

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
