import { NextResponse, NextRequest } from 'next/server';
import { buildErrorPayload } from '@/lib/api/error-format';
import { getRuntimeInventorySnapshot } from '@/lib/runtime/inventory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const fresh = req.nextUrl.searchParams.get('fresh') === '1';
    const snapshot = await getRuntimeInventorySnapshot({ fresh });

    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    console.error('[runtime/inventory] Failed to load snapshot', error);
    return NextResponse.json(
      buildErrorPayload('Failed to load runtime inventory.', error),
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      },
    );
  }
}
