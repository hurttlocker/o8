import { NextResponse } from 'next/server';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const snapshot = await getRuntimeInventorySnapshot();

  return NextResponse.json(snapshot, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
