import { NextResponse } from 'next/server';
import { getWorkspaceReviewSnapshot } from '@/lib/review/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const snapshot = await getWorkspaceReviewSnapshot();
    return NextResponse.json(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to load workflow review snapshot',
      },
      { status: 500 },
    );
  }
}
