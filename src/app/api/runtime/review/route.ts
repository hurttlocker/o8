import { NextRequest, NextResponse } from 'next/server';
import { getOwnedCodexReviewPacket } from '@/lib/codex/owned';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const surfaceId = request.nextUrl.searchParams.get('surfaceId')?.trim();
  if (!surfaceId) {
    return NextResponse.json({ error: 'surfaceId is required' }, { status: 400 });
  }

  try {
    if (surfaceId.startsWith('codex-owned:')) {
      const packet = await getOwnedCodexReviewPacket(surfaceId);
      return NextResponse.json(packet, {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    return NextResponse.json({ error: 'Review packet is only available for owned runtime surfaces right now.' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load runtime review packet' },
      { status: 500 },
    );
  }
}
