import { NextRequest, NextResponse } from 'next/server';
import type { MobileHistoryResponse } from '@/lib/mobile/types';
import { getSessionTranscript } from '@/lib/openclaw/chat';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const sessionKey = request.nextUrl.searchParams.get('sessionKey')?.trim();
  const rawLimit = request.nextUrl.searchParams.get('limit');
  const parsedLimit = rawLimit ? Number.parseInt(rawLimit, 10) : 6;
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 20) : 6;

  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }

  try {
    const transcript = await getSessionTranscript(sessionKey, limit);
    const payload: MobileHistoryResponse = {
      sessionKey,
      transcript,
    };

    return NextResponse.json(payload, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to load mobile session history',
      },
      { status: 500 },
    );
  }
}
