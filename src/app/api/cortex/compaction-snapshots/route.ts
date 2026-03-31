import { NextRequest, NextResponse } from 'next/server';
import { listCompactionSnapshots } from '@/lib/cortex/compaction-snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const rawLimit = request.nextUrl.searchParams.get('limit');
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim() || undefined;
  const limit = rawLimit ? Number.parseInt(rawLimit, 10) : 20;

  if (!Number.isFinite(limit) || limit <= 0) {
    return NextResponse.json(
      { snapshots: [], count: 0, error: 'limit must be a positive integer' },
      { status: 400, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  }

  try {
    const snapshots = await listCompactionSnapshots({ limit, sessionKey });
    return NextResponse.json(
      {
        snapshots,
        count: snapshots.length,
      },
      {
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      },
    );
  } catch (error) {
    console.error(
      '[compaction-snapshot] Failed to list compaction snapshots',
      error instanceof Error ? error.message : error,
    );
    return NextResponse.json(
      {
        snapshots: [],
        count: 0,
        error: 'Unable to list compaction snapshots',
      },
      {
        status: 500,
        headers: { 'Cache-Control': 'no-store, max-age=0' },
      },
    );
  }
}
