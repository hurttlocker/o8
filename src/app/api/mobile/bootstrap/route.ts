import { NextRequest, NextResponse } from 'next/server';
import { getMobileBootstrap, toBootstrapResponse } from '@/lib/render/bootstrap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const fresh = req.nextUrl.searchParams.get('fresh') === '1';
    const bootstrap = await getMobileBootstrap({ fresh });
    return NextResponse.json(toBootstrapResponse(bootstrap), {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'Server-Timing': bootstrap.serverTiming,
        'x-cortex-bootstrap-source': bootstrap.source,
        'x-cortex-bootstrap-state': bootstrap.state,
        'x-cortex-bootstrap-refreshed-at': String(bootstrap.refreshedAt ?? ''),
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to load mobile bootstrap',
      },
      { status: 500 },
    );
  }
}
