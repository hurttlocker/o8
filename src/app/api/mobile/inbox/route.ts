import { NextResponse } from 'next/server';
import { getMobileInboxSnapshot } from '@/lib/mobile/openclaw';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const snapshot = await getMobileInboxSnapshot();

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
