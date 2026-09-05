import { NextRequest, NextResponse } from 'next/server';
import { buildErrorPayload } from '@/lib/api/error-format';
import { getMobileInboxSnapshot } from '@/lib/mobile/inbox';
import { performance } from 'node:perf_hooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const startedAt = performance.now();
  try {
    const fresh = req.nextUrl.searchParams.get('fresh') === '1';
    const rawLimit = req.nextUrl.searchParams.get('limit');
    const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : Number.NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : undefined;
    const includeWorkspaceReview = req.nextUrl.searchParams.get('workspaceReview') !== '0';
    const snapshot = await getMobileInboxSnapshot({ fresh, limit, includeWorkspaceReview });

    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
      },
    });
  } catch (error) {
    console.error('[mobile/inbox] Failed to load snapshot', error);
    return NextResponse.json(
      buildErrorPayload('Failed to load mobile inbox.', error),
      {
        status: 500,
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          'Server-Timing': `total;dur=${Math.max(0, performance.now() - startedAt).toFixed(1)}`,
        },
      },
    );
  }
}
