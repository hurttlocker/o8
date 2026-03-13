import { NextRequest, NextResponse } from 'next/server';
import { getOwnedCodexRuntimeTail } from '@/lib/codex/owned';
import { getCodexRuntimeTail } from '@/lib/codex/sessions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const surfaceId = request.nextUrl.searchParams.get('surfaceId');
  if (!surfaceId) {
    return NextResponse.json({ error: 'surfaceId is required' }, { status: 400 });
  }

  try {
    if (surfaceId.startsWith('codex-owned:')) {
      const payload = await getOwnedCodexRuntimeTail(surfaceId);
      return NextResponse.json(payload, {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    if (surfaceId.startsWith('codex:')) {
      const payload = await getCodexRuntimeTail(surfaceId);
      return NextResponse.json(payload, {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
        },
      });
    }

    return NextResponse.json({ error: 'Unsupported runtime surface' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to read runtime tail' },
      { status: 500 },
    );
  }
}
